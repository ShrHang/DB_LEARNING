# MongoDB 数据库设计

数据库结构由 [初始化模块](../src/db/init.js) 定义。运行需要支持事务的 MongoDB 副本集；本地实例的配置和启停见 [README](../README.md)，对外数据格式见 [API](api.md)。

## 1. 数据约定

- 填写者不能修改或撤回成功答卷；再次填写形成新答卷，并受重复填写策略约束。作者可按[整卷删除契约](#survey-deletion-data)永久删除问卷及全部答卷。
- 仅保存最终有效答案和服务端重算的路径，不保存完整交互历史或标题/说明快照；答卷展示当前问卷标题和说明。
- 首份答卷与题目冻结在同一事务内完成；定义版本不匹配的提交被拒绝。
- 用户名大小写敏感；数值采用普通浮点运算，整数必须能精确表示。

## 2. 集合边界与选择理由

| 集合 | 文档边界 | 主要访问方式 |
| --- | --- | --- |
| users | 一个账号一份文档 | 用户名登录、按 ID 获取账号 |
| surveys | 一份问卷及其题目、选项、校验和规则 | 作者列表、整份编辑、分享链接读取 |
| submissions | 一次成功提交一份文档，内嵌有效答案 | 整卷/单题统计、逐题明细、完整答卷、幂等与次数查询 |
| sessions | 一个登录会话一份文档 | 按会话 ID 鉴权和到期检查 |
| surveyGuards | 每份现存问卷一条内部协调记录 | 新增答卷事务写 token，整卷删除事务删记录；不向作者输出 |

题目、选项与规则内嵌在 surveys 中，共同读取和校验。答卷独立存储以支持持续增长、分页和聚合；每份答卷内嵌本次最终答案。

## 3. 类型和标识约定

- users、surveys、submissions、surveyGuards 的 `_id` 和集合间用户/问卷引用使用 BSON ObjectId，API 边界转换为字符串；sessions 的 `_id` 为字符串。
- 问卷内题目和选项使用稳定字符串 ID；重排或修改文字不改变 ID。题目 ID 不能使用保留值 END。
- 题目数组顺序是展示顺序，规则数组顺序是匹配优先级；跳转引用 ID，不引用题号或选项文字。
- 日期使用 BSON Date，接口使用带时区的 ISO 8601。截止判定采用服务器时间。
- `schemaVersion` 表示持久化结构版本，业务集合当前写入值为 1；不等于内容定义版本。
- 数值使用 JavaScript Number 对应的 BSON 数值类型；整数校验使用安全整数范围，普通小数接受二进制浮点精度，不使用 Decimal128 作为默认答案类型。

## 4. users

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| _id | ObjectId | 主键 |
| username | string | 唯一、大小写敏感；不建立小写化用户名作为唯一键 |
| passwordHash | string | 带盐哈希的编码结果；不返回给客户端 |
| createdAt | Date | 注册时间 |
| schemaVersion | integer | 初始 1 |

username 的唯一索引与登录查询均使用 simple 二进制比较语义，Alice 和 alice 可分别注册。密码使用随机盐和 scrypt 保存编码哈希；输入规则见 [API](api.md)。

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

题目结构示例（使用简短 ID 便于阅读）：

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
- 文本约束使用 minLength/maxLength，长度按 Unicode 码点计算；数字使用 min/max/integer。
- 单选条件支持 eq/ne；多选支持 contains_any/contains_all/equals_set，条件值为非空且不重复的选项 ID 数组；数值支持 eq/ne/gt/gte/lt/lte/between，between 使用闭区间 `[min, max]`；文本题不支持跳转规则。
- 草稿可缺省条件，条件值可为 null，多选条件可为空数组，between 可暂存单边 null；空操作符入库前规范为缺省。发布及首次发布后的内容保存要求完整合法的定义，不能保留这些占位值。
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

服务端根据固定的最终答案复核路径，规则仅依赖当前题答案：

1. 建立题目和答案 ID 索引，拒绝重复/未知题目与非法版本。
2. 从第一题开始，校验当前题答案，按首条命中规则或默认顺序求下一题。
3. 记录本次验证已访问的题目；到 END 时得到有效路径，拒绝路径外提交内容；客户端发送前从缓存剔除这些内容。
4. 若同题在本次固定答案验证中再次出现，其后继选择也相同，证明当前最终答案未形成通向 END 的路径；返回“尚未形成可提交路径”，不继续遍历，不生成答卷。

这里不限制填写时的访问次数，不禁止发布有环图，也不妨碍反复修改答案；只判断一次声称已完成的提交是否真的存在有效结束路径。客户端缓存可以保留历史分支供回填，数据库只保存服务端确认的最终路径。

例：填写时曾走 Q1 → Q2 → Q3 → Q2，修改 Q2 后转向 Q4 → END；最终答案重算路径为 Q1 → Q2 → Q4，Q3 不保存。

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
| surveyGuards | 默认 `_id` 唯一索引 | 每份问卷仅一条协调记录 |

所有问卷的重复策略首次发布后冻结，因此同一问卷不会混用不同 singleOnly 策略。唯一索引负责并发兜底，不能用“先查有无，再插入”替代。sessions 的 `{ expires: 1 }` 索引设置 `expireAfterSeconds: 0`；TTL 仅清理数据，鉴权仍主动检查到期时间。

题目 ID 在问卷内、选项 ID 和可选规则 ID 在所属题目内的唯一性由服务端验证，不能依靠普通数组唯一索引保证。单题答案查询按 surveyId 过滤并检查 answers 与 effectivePath。

## 9. 原子性、版本与提交事务

- 题目定义实质变化：按 ownerId、revision、contentLocked=false 条件更新同一问卷文档，同时递增 revision 和 definitionRevision。
- 首份提交：在事务内校验当前问卷定义版本、状态、截止时间和填写策略，更新同一问卷文档的冻结字段，并插入答卷；任一失败整体回滚。
- 并发编辑与首份提交竞争同一问卷文档；发生冲突后重新检查，不能保存定义版本不符的答案，也不能留下“无成功答卷却已永久冻结”的状态。
- 后续提交使用已经冻结的内容版本；标题和说明变化不导致定义失效。页面 definitionRevision 不同则拒绝。
- 幂等重试优先检查现有答卷：同标识同内容返回原成功结果；不同内容报冲突。即使问卷后来关闭或到期，返回已成功的结果也不算新增受理。
- transaction 重试仍使用同一 requestId；唯一冲突应区分重复账号限制和同请求重试。
- 每次事务尝试的首个数据库读取为读取问卷，紧接着采样服务端时间并检查开放状态、截止及定义版本，这一检查是受理点。已受理的后续提交可在关闭后完成；首份提交仍可能因冻结写入与管理更新冲突。事务回调重试须重新读取和受理，不能沿用前次结论。

请求正文校验和有限路径计算在事务前完成，事务内重新校验问卷版本。事务使用 snapshot 读取、majority 写入和 primary 读取偏好；提交确认超时上限为 10 秒。错误与结果待确认处理见 [API](api.md)。

sessions 由 express-session + connect-mongo 管理，顶层为字符串 `_id`、字符串或对象 `session` 载荷以及 Date 类型 `expires`。载荷保存 userId、issuedAt、absoluteExpiresAt、csrfToken 等；不要求业务文档的 schemaVersion。登录后固定 24 小时，请求不续期，服务端主动检查 absoluteExpiresAt。

## 10. 初始化、校验与统计

- 数据库 `$jsonSchema` 校验字段类型、必填、枚举及嵌套形状；服务端负责权限、跨字段引用、题型约束、规则求值和发布后不可变性。
- 统计从 submissions 聚合，不单独持久化选项计数。按有效非空答案统计，填空明细分页，数值均值不包含空答，0 是有效数值。
- 初始化补建缺失集合和索引，使用 strict/error 校验模式，保留业务数据；不兼容的结构会阻止初始化，不静默覆盖。
- 未选选项的次数返回 0；无有效数值时 average=null；有效回答数为 0 时 percentage=null。百分比以该题非空有效回答数为分母，多选合计可超过 100%。

统计按 surveyId 筛选 submissions，以同一 `$facet` 输入计算整卷总量、题目非空回答数及选项次数。逐题明细只包含最终路径内的非空回答；答卷以 submittedAt/_id 降序分页，仅为本页实名答卷关联 username。匿名行在关联前移除 respondentId，服务输出再执行白名单。

<a id="survey-deletion-data"></a>

## 11. 整卷删除与事务协调

永久删除目标包括 surveys 文档、该 surveyId 下全部 submissions 及内部协调记录；不删除 users、sessions 或其他问卷。资格、确认及重试规则见 [删除 API](api.md#survey-deletion-api)。

### 11.1 为提交与删除建立共同写入点

`surveyGuards` 每份问卷一条记录：`{_id: ObjectId(问卷ID), token: ObjectId, schemaVersion: 1}`，不存账号、答案、历史或删除墓碑。

每次新增答卷事务都将 token 改为新的 ObjectId，删除事务删除同一协调记录，以共同写入建立冲突，防止删除后留下并发插入的答卷。不改变值的更新不能代替实际写入。独立协调记录使已受理的后续提交不因额外写问卷而与普通关闭/期限修改冲突。实现见 [协调仓储](../src/repositories/survey-guards.js)。

### 11.2 初始化与故障处理

- 开始接收 HTTP 请求前，初始化为现存问卷幂等补建缺失的协调记录，不覆盖已有 token。
- 新建问卷与新建协调记录在同一事务完成，失败一并回滚；不能出现可提交但没有协调记录的新问卷。
- 运行时提交/删除只操作已有协调记录，缺失时明确失败并排查初始化；禁止在旧快照中upsert重建已被删除的记录。协调记录缺失而问卷仍在属于服务异常，不视为已删除。

### 11.3 事务顺序与不变量

新增提交先在事务中读取问卷并检查受理时间、状态和定义版本，再更新协调 token、检查同请求答卷、执行首份冻结和答卷插入；各操作串行 await 并传同一 session。事务回调重试时从头重新受理。事务外发现的成功重放直接返回，不插入答卷或重建协调记录。

删除事务读取自有问卷，校验revision和服务端当前资格（draft、closed，或published且deadlineAt已到），删除已有协调记录，再删除该问卷全部答卷与问卷文档，按snapshot/majority提交。问卷删除本身与重开/延长期限的写入建立冲突；冲突重试须重新检查资格，不能复用旧快照结论。

后续提交先完成时，删除重试后包含这份新答卷；首份提交若导致 revision 变化，则返回 409，须重新预览确认。删除先完成时，在途提交冲突回滚，重新读取将找不到问卷。成功删除后不留下问卷、答卷或协调记录，原成功 requestId 也不能恢复数据。删除中途失败全部回滚，结果未知时不能提前报告成功；事务资源或时间限制不会触发不受事务保护的分批永久删除。
