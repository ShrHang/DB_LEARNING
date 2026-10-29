# MongoDB 数据库设计

数据库结构由 [初始化模块](../src/db/init.js) 定义。运行需要支持事务的 MongoDB 副本集；本地实例的配置和启停见 [README](../README.md)，对外数据格式见 [API](api.md)。

## 1. 数据约定

- 填写者不能修改或撤回成功答卷；再次填写形成新答卷，并受重复填写策略约束。作者可按[整卷删除契约](#survey-deletion-data)永久删除问卷及全部答卷。
- 仅保存最终有效答案和服务端重算的路径，不保存完整交互历史或标题/说明快照；答卷展示当前问卷标题和说明。
- 发布冻结题目；首份答卷与首次提交时间在同一事务内完成；定义版本不匹配的提交被拒绝。
- 用户名大小写敏感；数值采用普通浮点运算，整数必须能精确表示。

## 2. 集合边界与选择理由

| 集合 | 文档边界 | 主要访问方式 |
| --- | --- | --- |
| users | 一个账号一份文档 | 用户名登录、按 ID 获取账号 |
| surveys | 一份问卷及其题目、选项、校验和规则 | 作者列表、整份编辑、分享链接读取 |
| submissions | 一次成功提交一份文档，内嵌有效答案 | 整卷/单题统计、逐题明细、完整答卷、幂等与次数查询 |
| sessions | 一个登录会话一份文档 | 按会话 ID 鉴权和到期检查 |
| surveyGuards | 每份现存问卷一条内部协调记录 | 新增答卷事务写 token，整卷删除事务删记录；不向作者输出 |
| questions | 一个独立题目的身份及版本分配状态 | 所有者列表、归档、授权协调 |
| questionVersions | 一个不可变版本的内容和来源 | 指定版本读取、历史及分支查询 |
| questionShares | 一个题目对一个接收用户的授权 | 授权检查、共享列表 |
| questionBanks | 一个个人具名题库 | 分类列表和管理 |
| questionBankItems | 一个题库的一条题目收录关系 | 分类选题，不扩展原题权限 |

问卷内嵌所选版本的内容及局部配置，支持整份读取和校验；独立题目与版本负责复用、历史及共享。答卷独立增长，每份内嵌最终答案；授权和题库收录独立成文档，避免无界成员数组。

## 3. 类型和标识约定

- 除 sessions 外，各集合的 `_id` 及集合间引用使用 BSON ObjectId；API边界转换为字符串。sessions 的 `_id` 为字符串，问卷内 reference 的两个ID也使用小写十六进制字符串，便于共享纯函数处理。
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
| questions | array | 内嵌题目及可选 reference，顺序即默认答题顺序 |
| definitionRevision | integer | 初始 1；题目、选项、校验、规则或顺序变化时递增 |
| revision | integer | 问卷并发编辑版本，管理更新时递增 |
| contentLocked | boolean | 首次发布时为 true，永久禁止题目定义变化 |
| firstSubmittedAt | Date 或 null | 首次成功提交时间，与首份答卷同事务写入 |
| createdAt / updatedAt | Date | 创建/更新时刻 |
| firstPublishedAt | Date 或 null | 判断是否已首次发布，支持冻结填写策略 |
| schemaVersion | integer | 初始 1 |

contentLocked 在首次发布时设为 true，关闭和重开不解除冻结；firstSubmittedAt 可继续为 null。首份答卷仅写入首次提交时间和管理修订号，不维护选项计数或总答卷数。

标题、说明和截止时间变化不递增 definitionRevision，避免仅修改说明就迫使填写者重填；它们仍更新 revision。每次题目定义保存均带作者和旧 revision 条件，避免并发编辑覆盖。发布、重开、冻结字段的具体更新权限在服务层统一控制。

关联独立版本的题目含 `reference:{questionId,versionId}`，并内嵌该版本的 type/title/options/validation，以及局部 required/rules。服务端核验授权和内容后物化，拒绝伪造；答卷仍以问卷内 questionId 关联，不复制来源到每条答案。独立版本字段见第12节。

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
- 草稿可缺省条件，条件值可为 null，多选条件可为空数组，between 可暂存单边 null；空操作符入库前规范为缺省。发布要求完整合法的定义，之后不允许修改题目，不能保留这些占位值。
- 完整定义中 target 为题目 ID 或保留值 END；草稿未选目标可暂存 null，发布时必须补全，之后不允许修改题目。无匹配默认下一题，空答不匹配条件。允许回跳和有环图。

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

value 按题型为选项 ID、选项 ID 数组、文本或数值；路径内空答统一存 null，路径外题目无答案条目。路径外缓存、改动前的答案及点击历史不进入该文档。题目定义已因首次发布冻结，不在每份答卷复制整份题目和选项；标题/说明也不做快照。

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
| surveys | `{ownerId:1,"questions.reference.versionId":1}` | 自有问卷的版本引用查询 |
| questions | `{ownerId:1,_id:-1}` | 自有题目列表 |
| questionVersions | `{questionId:1,number:1}` unique；`{sourceVersionId:1}` | 版本号唯一与来源查询 |
| questionShares | `{questionId:1,userId:1}` unique；`{userId:1,questionId:1}` | 授权唯一与共享列表 |
| questionBanks | `{ownerId:1,_id:-1}` | 个人题库列表 |
| questionBankItems | `{bankId:1,questionId:1}` unique | 不重复收录 |

所有问卷的重复策略首次发布后冻结，因此同一问卷不会混用不同 singleOnly 策略。唯一索引负责并发兜底，不能用“先查有无，再插入”替代。sessions 的 `{ expires: 1 }` 索引设置 `expireAfterSeconds: 0`；TTL 仅清理数据，鉴权仍主动检查到期时间。

题目 ID 在问卷内、选项 ID 和可选规则 ID 在所属题目内的唯一性由服务端验证，不能依靠普通数组唯一索引保证。单题答案查询按 surveyId 过滤并检查 answers 与 effectivePath。

## 9. 原子性、版本与提交事务

草稿按ownerId、revision及contentLocked=false更新，题目变化同时递增revision和definitionRevision。发布后题目不可改，标题、说明和截止时间不改变定义版本。

提交在事务前复核答案与有限路径；每次事务尝试先读问卷，再采样时间检查状态、截止、版本及填写策略，作为受理点。更新guard后检查同请求，首份记录firstSubmittedAt并插入答卷；各步同session串行执行。冲突回滚后重新受理，失败不留下首次时间或答卷，发布冻结继续有效。

幂等重放先检查已保存请求，同内容返回原成功结果、不同内容报冲突；关闭或到期不阻止成功重放。重试保留requestId，唯一冲突须区分同请求和账号次数限制。事务使用snapshot读取、majority写入和primary偏好，提交确认超时10秒；未知结果及受理细节见 [系统设计](design.md#5-提交幂等与事务) 和 [API](api.md)。

sessions 由 express-session + connect-mongo 管理，顶层为字符串 `_id`、字符串或对象 `session` 载荷以及 Date 类型 `expires`。载荷保存 userId、issuedAt、absoluteExpiresAt、csrfToken 等；不要求业务文档的 schemaVersion。登录后固定 24 小时，请求不续期，服务端主动检查 absoluteExpiresAt。

## 10. 初始化、校验与统计

- 数据库 `$jsonSchema` 校验字段类型、必填、枚举及嵌套形状；服务端负责权限、跨字段引用、题型约束、规则求值和发布后不可变性。
- 统计从 submissions 聚合，不单独持久化选项计数。按有效非空答案统计，填空明细分页，数值均值不包含空答，0 是有效数值。
- 初始化使用 strict/error 校验，补建集合与索引；不兼容结构阻止启动，不静默覆盖。可识别结构的升级规则见第12节。
- 未选选项的次数返回 0；无有效数值时 average=null；有效回答数为 0 时 percentage=null。百分比以该题非空有效回答数为分母，多选合计可超过 100%。

统计按 surveyId 筛选 submissions，以同一 `$facet` 输入计算整卷总量、题目非空回答数及选项次数。逐题明细只包含最终路径内的非空回答；答卷以 submittedAt/_id 降序分页，仅为本页实名答卷关联 username。匿名行在关联前移除 respondentId，服务输出再执行白名单。

<a id="survey-deletion-data"></a>

## 11. 整卷删除与事务协调

永久删除目标包括 surveys 文档、该 surveyId 下全部 submissions 及内部协调记录；不删除 users、sessions 或其他问卷。资格、确认及重试规则见 [删除 API](api.md#survey-deletion-api)。

`surveyGuards` 每份问卷一条 `{_id: ObjectId(问卷ID), token: ObjectId, schemaVersion:1}`，不存账号、答案或墓碑。新增答卷真实更新token，删除移除同一记录，以写冲突协调在途提交；不改变值的更新不能代替实际写入。独立guard使后续提交不额外写问卷，保留关闭前已受理请求可完成的语义。

初始化为现存问卷幂等补建guard，不覆盖token；新问卷与guard原子创建。运行时缺失guard须报服务异常，不允许upsert重建。删除事务重查所有权、revision和资格，依次删除guard、全部答卷和问卷，以snapshot/majority提交；任一失败全部回滚，不退化为非事务分批清理。

提交先完成时，删除重试包含其结果；首份导致revision变化时须重新预览。删除先完成时，在途提交回滚后读不到问卷。删除与重开/延期也竞争问卷写入，重试须重查资格。成功后无孤立答卷，旧requestId不能恢复数据。实现见 [guard仓储](../src/repositories/survey-guards.js)、[删除服务](../src/services/deletion-service.js)，页面及重试合同见 [系统设计](design.md#survey-deletion-design)。

## 12. 独立题目、版本与题库

各集合均含 `_id` 和 schemaVersion=1。字段边界如下，索引统一见第8节。

| 集合 | 字段与用途 |
| --- | --- |
| questions | ownerId、archived、nextVersion、revision、token、createdAt、updatedAt；一题一文档 |
| questionVersions | questionId、number、parentVersionId、sourceVersionId、operation、content、createdAt；一版本一文档，服务层仅插入 |
| questionShares | questionId、userId、createdAt；一接收者一授权 |
| questionBanks | ownerId、name、revision、createdAt |
| questionBankItems | bankId、questionId、createdAt |

content 仅含 type/title/options/validation，保存前完整校验。大于 Int32 的安全整数计数限制编码为 BSON Long，读取和接口仍为 Number。operation 为 create/edit/restore/fork；父版本表示同题分支，sourceVersionId 表示另存来源。nextVersion 初始 2，初始版本编号 1；版本创建与题目编号、revision 更新同事务提交。

新增使用与撤销/归档共同写 questions.token。授权检查、真实 token 更新和引用保存必须同事务；撤销或归档先提交时，旧快照写冲突后重新授权；引用先提交时，撤销只影响后续新增。普通草稿保留同一实例的相同引用时使用已有内嵌内容，不要求原授权仍有效。删除题库与收录关系同事务，加入收录同时写题库以协调删除。

初始化只接受精确识别的已交付校验器，补建集合/索引并扩展 reference 校验；首次发布过但未冻结的问卷设 contentLocked=true，不改题目、定义修订号、答卷、会话或幂等字段。升级应先停止旧应用，再执行初始化和启动新应用；重复执行保留业务数据。不自动为旧题推断身份或合并历史回答。
