# MongoDB 数据库设计

状态：M1—M5 已验收；已实现四集合基础 validator、索引和幂等初始化，并以真实副本集验证约束与事务能力。代码见 [初始化](../src/db/init.js)，证据见 [测试记录](test-cases.md#10-m2-实际执行记录)。M3 已实现草稿结构与发布完整校验、管理条件更新、冻结限制与旧校验器兼容升级；M4已实现并验证最终路径、幂等提交及首份冻结事务，已获用户验收，证据见[第13节](test-cases.md#13-m4-实际执行记录)；M5统计/作者明细已实现并通过用户验收。依据见 [requirements.md](requirements.md)。

第5轮新增协调集合与删除事务已实现并获用户验收，见[第11节](#survey-deletion-data)；原四集合的数据边界保留，增加一个内部协调集合。升级在应用启动的初始化中执行，测试只使用独占随机库，不在开发数据上验证删除。当前本轮文档收尾不操作数据库；M6复现核查待提交后按计划开展。

## 1. 已确认的数据需求

| 编号 | 决策 |
| --- | --- |
| B1 | 填写者不可修改或撤回成功提交的答卷；再次填写形成新答卷，须符合重复填写策略。作者整卷永久删除的独立操作另见[需求E系列](requirements.md#survey-deletion-requirements) |
| B2 | 仅长期保存最终有效答案及必要路径信息，不长期保存完整交互历史，不提供过程回放 |
| B3 | 旧答卷展示当前问卷标题和说明，不保存标题/说明历史快照 |
| B4 | 本机配置单节点副本集，使用事务保证首份答卷保存和内容冻结一致；M2 已建立独立实例，业务提交事务在 M4 实现 |
| B5 | 内容定义变化后，旧版页面提交被拒绝，提示重新载入最新版填写 |
| B6 | 用户名区分大小写，Alice 和 alice 可分别注册 |
| B7 | 普通数值计算即可，整数必须能精确表示，不要求精确十进制运算 |
| B8 | 最终有效路径以最终答案从第一题重新计算到结束的结果为准，历史分支答案不保存 |

## 2. 集合边界与选择理由

| 集合 | 文档边界 | 主要访问方式 |
| --- | --- | --- |
| users | 一个账号一份文档 | 用户名登录、按 ID 获取账号 |
| surveys | 一份问卷及其题目、选项、校验和规则 | 作者列表、整份编辑、分享链接读取 |
| submissions | 一次成功提交一份文档，内嵌有效答案 | 整卷/单题统计、逐题明细、完整答卷、幂等与次数查询 |
| sessions | 一个登录会话一份文档 | 按会话 ID 鉴权和到期检查 |
| surveyGuards（第5轮新增） | 每份现存问卷一条内部协调记录 | 新增答卷事务写token，整卷删除事务删记录；不向作者输出 |

题目、选项与规则随问卷共同读取并一起校验，第一阶段内嵌在 surveys；不将选项和规则机械拆成集合。答卷持续增加且需要独立分页和聚合，因此从问卷分离，不在 surveys 中累积 submissions 数组。每份答卷的答案共同提交和查看，适合内嵌。

MongoDB 的内嵌与引用应按访问方式选择，不能将关联数据全部放进单一文档；参见 [内嵌设计](https://www.mongodb.com/docs/manual/data-modeling/embedding/)与[无界数组问题](https://www.mongodb.com/docs/v8.0/data-modeling/design-antipatterns/unbounded-arrays/)。这是文档边界的选择理由，不意味着关系数据库不能实现该系统。

## 3. 类型和标识约定

- 集合顶层 `_id` 和集合间用户/问卷引用使用 BSON ObjectId，API 边界转换为字符串。
- 问卷内题目和选项使用稳定字符串 ID，建议 UUID；重排或修改文字不改变 ID。
- 题目数组顺序是展示顺序，规则数组顺序是匹配优先级；跳转引用 ID，不引用题号或选项文字。
- 日期使用 BSON Date，接口使用带时区的 ISO 8601。截止判定采用服务器时间。
- `schemaVersion` 表示持久化结构版本，用于第二阶段迁移；不等于内容定义版本。
- 数值使用 JavaScript Number 对应的 BSON 数值类型；整数校验使用安全整数范围，普通小数接受二进制浮点精度，不使用 Decimal128 作为默认答案类型。

## 4. users

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| _id | ObjectId | 主键 |
| username | string | 唯一、大小写敏感；不建立小写化用户名作为唯一键 |
| passwordHash | string | 带盐哈希的编码结果；不返回给客户端 |
| createdAt | Date | 注册时间 |
| schemaVersion | integer | 初始 1 |

username 的唯一索引使用 simple 二进制比较语义，登录查询使用同一比较方式，避免集合默认排序规则改变大小写行为。允许字符、长度及密码处理已在 C6 确认，见 [后端设计](design.md)。

## 5. surveys

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| _id / ownerId | ObjectId | 问卷 ID / 作者 ID |
| slug | string | 随机生成的唯一分享标识，不替代权限验证 |
| title / description | string | 当前标题/说明；发布后仍可更新 |
| status | enum | draft、published、closed；到期由截止时间派生，不另存 expired 状态 |
| settings.anonymityMode | enum | forced、optional、forbidden；首次发布后冻结 |
| settings.allowMultipleSubmissions | boolean | 默认 false；首次发布后冻结 |
| deadlineAt | Date 或 null | null 表示不设截止 |
| questions | array | 题目内嵌，顺序即默认答题顺序 |
| definitionRevision | integer | 初始 1；题目、选项、校验、规则或顺序变化时递增 |
| revision | integer | 问卷并发编辑版本，管理更新时递增 |
| contentLocked | boolean | 首份答卷成功提交后为 true，永久禁止题目定义变化 |
| firstSubmittedAt | Date 或 null | 首次成功提交时间，与首次冻结同事务写入 |
| createdAt / updatedAt | Date | 创建/更新时刻 |
| firstPublishedAt | Date 或 null | 判断是否已首次发布，支持冻结填写策略 |
| schemaVersion | integer | 初始 1 |

contentLocked 与答卷存在性有关，但保留该字段用于问卷文档上的条件更新。通过事务维护它与首份答卷的一致性，不维护重复的选项计数或问卷总答卷数。

标题、说明和截止时间变化不递增 definitionRevision，避免仅修改说明就迫使填写者重填；它们仍更新 revision。每次题目定义保存均带作者和旧 revision 条件，避免并发编辑覆盖。发布、重开、冻结字段的具体更新权限在服务层统一控制。

题目结构示例（ID 为阅读方便使用短名，实现时使用稳定生成的 ID）：

```json
{
  "id": "q_age",
  "type": "number",
  "title": "年龄",
  "required": true,
  "validation": { "min": 0, "max": 120, "integer": true },
  "rules": [
    { "condition": { "operator": "lt", "value": 18 }, "target": "q_student" },
    { "condition": { "operator": "gte", "value": 18 }, "target": "END" }
  ]
}
```

- 内部题型：single_choice、multiple_choice、text、number。
- 选择题额外包含 `options: [{ id, label }]`。
- 多选约束使用 minSelections/maxSelections；精确 N 个表示为两者均为 N。长度/选择数量为非负安全整数；超过Int32的计数在仓储写入时编码为BSON Long，驱动读取后仍为安全范围内的JavaScript Number，API不暴露BSON对象。
- 文本约束使用 minLength/maxLength；数字使用 min/max/integer。
- 操作符白名单：eq、ne、gt、gte、lt、lte、between、contains_any、contains_all、equals_set；between 使用 `[min, max]`，多选条件使用选项 ID 数组。
- M3 草稿条件值允许null，多选允许空数组，between允许[下界或null, 上界或null]；空操作符规范为缺省。完整定义不接受这些未完成条件。数据库初始化仅精确认识已交付M2的旧surveys validator并扩展区间null占位，不改文档和schemaVersion，不覆盖其他不兼容修改。
- 完整定义中 target 为题目 ID 或保留值 END；草稿未选目标可暂存 null，发布及首次发布后的内容保存时必须补全。无匹配默认下一题，空答不匹配条件。允许回跳和有环图。

## 6. submissions

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| _id / surveyId | ObjectId | 答卷 ID / 所属问卷 |
| definitionRevision | integer | 成功提交所依据的问卷定义版本 |
| respondentId | ObjectId | 从登录会话取得；匿名也保留，仅内部使用 |
| anonymous | boolean | 服务端按问卷模式验证后的实际提交方式 |
| singleOnly | boolean | 服务端依据问卷策略生成，不能接受客户端直接指定 |
| requestId | string | 一次主动提交的幂等标识，网络重试沿用 |
| requestHash | string | 规范化提交内容摘要，检查同标识不同内容冲突 |
| answers | array | 最终有效答案，每题最多一个 `{ questionId, value }` |
| effectivePath | string[] | 服务端计算的最终题目路径，不是完整交互历史 |
| submittedAt | Date | 服务端记录的提交时间 |
| schemaVersion | integer | 初始 1 |

value 按题型为选项 ID、选项 ID 数组、文本或数值；路径内空答统一存 null，路径外题目无答案条目。路径外缓存、改动前的答案及点击历史不进入该文档。题目定义已因首份答卷冻结，不在每份答卷复制整份题目和选项；标题/说明也不做快照。

作者查询按所有权限定问卷，响应使用明确字段白名单。匿名不返回 respondentId、requestId、requestHash、次数约束字段或可反查身份的信息；实名需要显示用户名时由服务端关联 users，仅返回允许展示的账号信息。认证会话集合不向作者查询接口开放。

## 7. 最终有效路径的有限复核

B8 消除了长期保存完整作答历史的需求。设本次提交使用的答案固定，规则仅依赖当前题答案，则可以：

1. 建立题目和答案 ID 索引，拒绝重复/未知题目与非法版本。
2. 从第一题开始，校验当前题答案，按首条命中规则或默认顺序求下一题。
3. 记录本次验证已访问的题目；到 END 时得到有效路径，拒绝路径外提交内容；客户端发送前从缓存剔除这些内容。
4. 若同题在本次固定答案验证中再次出现，其后继选择也相同，证明当前最终答案未形成通向 END 的路径；返回“尚未形成可提交路径”，不继续遍历，不生成答卷。

这里不限制填写时的访问次数，不禁止发布有环图，也不妨碍反复修改答案；只判断一次声称已完成的提交是否真的存在有效结束路径。客户端缓存可以保留历史分支供回填，数据库只保存服务端确认的最终路径。

例：初始 Q1 → Q2 → Q3 → Q2，修改 Q2 后转向 Q4 → END；最终答案重算路径为 Q1 → Q2 → Q4，Q3 不保存。该例应进入自动测试。

## 8. 索引与职责

| 集合 | 索引 | 用途 |
| --- | --- | --- |
| users | `{ username: 1 }` unique，simple collation | 大小写敏感的用户名唯一性 |
| surveys | `{ slug: 1 }` unique | 分享链接唯一 |
| surveys | `{ ownerId: 1, createdAt: -1, _id: -1 }` | 作者列表稳定分页 |
| submissions | `{ surveyId: 1, submittedAt: -1, _id: -1 }` | 答卷列表和按问卷聚合的入口 |
| submissions | `{ surveyId: 1, respondentId: 1, requestId: 1 }` unique | 同次提交重试不重复保存 |
| submissions | `{ surveyId: 1, respondentId: 1 }` unique，部分过滤 `{ singleOnly: true }` | 禁止多次填写时，并发也最多一份成功 |
| sessions | 会话主键，expires 的 TTL 索引 | express-session + connect-mongo 会话读取与清理；真实有效期另检查 absoluteExpiresAt |

所有问卷的重复策略首次发布后冻结，因此同一问卷不会混用不同 singleOnly 策略。唯一索引负责并发兜底，不能用“先查有无，再插入”替代。TTL 仅清理数据，鉴权仍主动检查到期时间。详见 MongoDB [唯一索引](https://www.mongodb.com/docs/manual/core/index-unique/)。

题目、选项和规则 ID 在单个问卷内的唯一性由服务端验证，不能依靠普通数组唯一索引保证。单题答案查询初期按 surveyId 过滤后展开 answers；是否需要额外多键索引根据后续查询验证决定。

## 9. 原子性、版本与提交事务

- 题目编辑：按 ownerId、revision、contentLocked=false 条件更新同一问卷文档，同时递增 revision 和 definitionRevision。
- 首份提交：在事务内校验当前问卷定义版本、状态、截止时间和填写策略，更新同一问卷文档的冻结字段，并插入答卷；任一失败整体回滚。
- 并发编辑与首份提交竞争同一问卷文档；发生冲突后重新检查，不能把旧版答案写入新版定义，也不能留下“无成功答卷却已永久冻结”的状态。
- 后续提交使用已经冻结的内容版本；标题和说明变化不导致旧定义失效。旧页面 definitionRevision 不同则拒绝，不进行旧版兼容存储。
- 幂等重试优先检查现有答卷：同标识同内容返回原成功结果；不同内容报冲突。即使问卷后来关闭或到期，返回已成功的结果也不算新增受理。
- transaction 重试仍使用同一 requestId；唯一冲突应区分重复账号限制和同请求重试。
- 已受理的提交可在关闭后完成；定义实际受理点、事务重试和冲突错误映射时保持 D6 语义。

请求正文校验和有限路径计算尽量在短事务前完成；事务内重新校验问卷版本，防止预校验后定义变化。受理点、重试及错误处理初稿已进入 [后端设计](design.md) 和 [API](api.md)，后续需用集成测试验证。

会话技术方案为 express-session + connect-mongo，文档形状由适配器管理，顶层包含会话主键、session 载荷及 expires。载荷保存 userId、issuedAt、absoluteExpiresAt、CSRF token 等；允许适配器采用其支持的序列化形状，不套用业务文档的 schemaVersion 要求。登录后固定 24 小时，不依赖适配器 touch 或 TTL 来判定是否仍登录。

本机采用项目独立单节点副本集支持事务；M2 已验证事务提交与回滚，未变更现有系统服务。[MongoDB 事务运行条件](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)、[副本集初始化说明](https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/)及[单文档原子性/条件更新](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)提供技术依据。

## 10. 校验、统计与后续工作

- 数据库 `$jsonSchema` 校验字段类型、必填、枚举及嵌套形状；服务端负责权限、跨字段引用、题型约束、规则求值和发布后不可变性。
- 统计从 submissions 聚合，不单独持久化选项计数。按有效非空答案统计，填空明细分页，数值均值不包含空答，0 是有效数值。
- 设计建议：未选选项显示 0；无有效数值时平均值返回 null；有效回答数为 0 时百分比返回 null，页面显示“暂无数据”，避免除零。此为展示约定草案。
- 保留 schemaVersion 和迁移脚本机制，以增量方式扩展第二阶段；第一阶段不预建未知需求的题库、历史版本或统计缓存。
- M2 已建立项目独立副本集：27018、local/mongodb、questionnaire-rs；验证可写主节点、初始化幂等、唯一/部分唯一索引与事务能力。启停脚本仅操作通过归属检查的项目实例。运行方法见 [README](../README.md)，进度见 [已交付与M5计划](../workflow/plan.md#m5)。
- 初始化/索引/schema、账号会话及问卷定义/管理已实现；M4已接入答案规则执行及真实提交事务，已以真实HTTP/副本集验证版本冲突、并发及匿名提交，M4已由用户验收；M5统计聚合、作者匿名过滤及分页已通过真实集成验证，并由用户验收。提交业务证据独立记录，不能用数据库基础探测替代。


M5使用现有submissions按surveyId筛选，以同一`$facet`输入计算整卷总量、题目非空回答数及选项次数；逐题明细先按最终路径筛选，答卷分页以submittedAt/_id排序，仅本页实名答卷关联username。匿名行在关联前去除respondentId，服务输出再执行白名单。未新增集合、schemaVersion、迁移或提交计数缓存。

<a id="survey-deletion-data"></a>

## 11. 删除扩展的数据方案与实现

依据[需求E1—E7](requirements.md#survey-deletion-requirements)。永久删除目标包括surveys文档、该surveyId下全部submissions，以及内部协调记录；不删除users、sessions或其他问卷。答卷不可由填写者编辑/撤回，作者整卷删除是新增的独立操作。

### 11.1 为提交与删除建立共同写入点

原M4代码仅首份提交写surveys，后续提交只读问卷并插入submissions。单靠删除事务中的查问卷、删答卷，不能把这些后续插入排除在外。第5轮新增内部集合`surveyGuards`，每份问卷一条记录：`{_id: ObjectId(问卷ID), token: ObjectId, schemaVersion: 1}`，使用默认_id唯一索引，不存账号、答案、历史或删除墓碑。

每次新增答卷的事务都实际更新对应token，删除事务则删除同一协调记录，使两者争用共同文档；不能用不改变值的更新假装获得协调。协调记录不放在问卷文档上，是为了让普通关闭/期限修改与已受理的后续提交仍保持D6行为，而不因额外写问卷引入冲突。仓储见[survey-guards](../src/repositories/survey-guards.js)，原四集合的schemaVersion及索引保留。

MongoDB事务中只读可能看到旧快照；共同写入用于建立冲突关系。实际故障、重试与快照结果已通过[真实验证](test-cases.md#survey-deletion-results)，不等于已验证任意规模。参见[官方事务生产注意事项](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)。

### 11.2 建立、兼容与故障处理

- 初始化创建并校验新集合；在开始接收HTTP请求前，为已有问卷幂等补建缺失的协调记录。保留旧问卷/答卷、schemaVersion、标识、索引与业务字段，不重写历史答案。
- 新建问卷与新建协调记录在同一事务完成，失败一并回滚；不能出现可提交但没有协调记录的新问卷。
- 运行时提交/删除只操作已有协调记录，缺失时明确失败并排查初始化；禁止在旧快照中upsert重建已被删除的记录。协调记录缺失而问卷仍在属于服务异常，不视为已删除。
- 升级时不混用未接入协调的旧应用进程；初始化不与旧版本创建问卷并行。单进程内存锁不作为数据库一致性的保证。

### 11.3 事务顺序与不变量

提交仍先在事务中读取问卷并按D6检查受理时间、状态和定义版本，随后实际更新协调token，再执行原有幂等检查、首份冻结和答卷插入；各操作串行await并传同一session。事务回调重试时从头重新受理。成功重放不插入答卷，不需要创建或重建协调记录。

删除事务读取自有问卷，校验revision和服务端当前资格（draft、closed，或published且deadlineAt已到），删除已有协调记录，再删除该问卷全部答卷与问卷文档，按snapshot/majority提交。问卷删除本身与重开/延长期限的写入建立冲突；冲突重试须重新检查资格，不能复用旧快照结论。

后续提交先完成时，删除重试后包含这份新答卷；首份提交若导致revision变化，则返回409，须重新预览确认后再删。删除先完成时，在途提交冲突回滚，重新读取将找不到问卷。成功删除后不得留下问卷、答卷或协调记录，不承诺保留曾经成功提交的答卷。删除中途失败全回滚；结果未知按E7确认，不能提前报告成功。大问卷删除若遇事务资源或时间限制，返回待确认/失败并保留一致状态，不退化为不受保护的分批永久删除；当前未做规模验证。

[真实验证](test-cases.md#15-m5-实际执行记录)包含受控hint explain：既有`surveyId_1_submittedAt_-1__id_-1`索引支持问卷内时间/ID排序，无额外SORT/COLLSCAN；这是指定查询形状的索引能力检查，不代表规模性能已测。
