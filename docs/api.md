# API 约定

所有路径以 `/api` 开头，由同一个 Express 应用提供。路由见 [app.js](../src/app.js)，持久化结构见 [数据库文档](database.md)。

## 1. 公共约定

- JSON 请求/响应；ObjectId 使用字符串，日期使用带时区 ISO 8601。
- 需要登录的接口使用 Cookie 会话，登录后固定有效 24 小时，请求不续期；写接口使用 `X-CSRF-Token`。先通过 `GET /auth/csrf` 获取 token，登录成功后使用新会话 token。
- 成功通常返回 `{ "data": ... }`，204 无正文。失败返回 `{ "error": { "code", "message", "details": [] } }`。
- 字段白名单校验，未知或服务端专属字段拒绝；JSON/压缩正文解析和字段类型错误为 400，业务输入不合要求为 422；正文超过1MiB为413，不支持的字符集/内容编码为415。
- 作者资源查询限定 ownerId；资源不存在与越权统一 404。
- 管理更新在正文携带读取时的 revision；过时版本为 409，不自动覆盖。
- 分页默认 20 条，limit 可设 1—100，返回 items、nextCursor；游标仅表示稳定排序位置，不授予访问权限，末页 nextCursor=null。

## 2. 账号接口

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /auth/csrf | 无须登录，可建立 CSRF 会话 | 200，csrfToken |
| POST /auth/register | CSRF；username、password | 201，账号 ID、用户名、注册时间，不自动登录 |
| POST /auth/login | CSRF；username、password | 200，user、expiresAt、csrfToken，并设置新会话 Cookie |
| GET /auth/me | 登录 | 200，user、固定 expiresAt |
| POST /auth/logout | 登录、CSRF | 204，销毁当前会话并清 Cookie |

用户名为 3—32 个 Unicode 码点，仅允许汉字、英文字母、数字、下划线和连字符，区分大小写，不允许空白。密码为 8—128 个 Unicode 码点，保留空格，不做 trim；含未配对 Unicode 代理项时返回 422。凭据不匹配统一为 401 INVALID_CREDENTIALS，不返回哈希。

注册 data 为 `{id,username,createdAt}`；登录和 me 的 user 使用相同白名单。未登录或固定期限到期返回 401 AUTH_REQUIRED。

## 3. 问卷管理

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /surveys | 登录；cursor、limit | 200，仅当前作者的问卷摘要列表 |
| POST /surveys | 登录、CSRF；title/description 默认空字符串，settings 必须显式选择 anonymityMode；可提供 deadlineAt、questions | 201，新草稿及管理字段 |
| GET /surveys/:id | 作者 | 200，完整管理定义及修订号 |
| PATCH /surveys/:id | 作者、CSRF；revision 及需修改的 title、description、settings、deadlineAt、questions | 200，更新后的问卷 |
| POST /surveys/:id/publish | 作者、CSRF；revision | 200，校验成功后发布并冻结填写策略 |
| POST /surveys/:id/close | 作者、CSRF；revision | 200，关闭状态及新 revision |
| POST /surveys/:id/reopen | 作者、CSRF；revision | 200，重开状态及新 revision，须满足截止要求 |

列表摘要为 `{id,title,description,status,deadlineAt,createdAt,updatedAt}`，按 createdAt/_id 降序。cursor 是 `{createdAt,id}` 的 base64url JSON 编码；ownerId 始终来自会话。只接受 cursor/limit，未知查询参数或无效分页参数返回 400；无问卷时 items=[]、nextCursor=null。

管理 data 白名单为 {id, slug, title, description, status, settings, deadlineAt, questions, revision, definitionRevision, contentLocked, firstSubmittedAt, firstPublishedAt, createdAt, updatedAt, schemaVersion, shareUrl}，shareUrl 为相对路径 /survey/:slug，不返回 ownerId。

settings 包含 anonymityMode（forced/optional/forbidden）和 allowMultipleSubmissions（默认 false）；deadlineAt 默认为 null，表示不设截止；questions 默认为空数组。

questions 采用完整数组提交以支持新增、删除和重排，现有题目/选项的 ID 保持不变；结构见数据库文档。草稿允许未选条件、null 条件值/目标和区间单边 null；空操作符入库前规范为缺省。发布及首次发布后的编辑要求完整合法。题目实质变化才递增 definitionRevision，单纯元信息/原样 questions 仅递增 revision。

首次发布后填写策略冻结，首份答卷成功后题目定义冻结；标题、说明和截止仍可修改。status、ownerId、contentLocked、firstPublishedAt 等由服务端管理，不能通过 PATCH 覆盖。状态操作仅支持 draft→published、published→closed、closed→published；重开时截止须未到或为 null，否则返回 409 DEADLINE_PASSED。

## 4. 填写与提交

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /fill/:slug | 登录 | 200，当前开放问卷的标题/说明、填写策略、题目、deadlineAt、definitionRevision；草稿不开放 |
| POST /fill/:slug/submissions | 登录、CSRF；见下方请求 | 新增201；同请求成功重试200，均返回相同答卷 ID |

分享页面路径为 `/survey/:slug`；接口不暴露作者管理字段。填写期间的校验和跳转由浏览器共享函数执行，无逐题提交或保存进度接口。

提交请求示意，短 ID 仅为便于阅读：

```json
{
  "requestId": "c94cb9c3-d092-451b-8a6a-7cfcd193b1f6",
  "expectedUserId": "000000000000000000000001",
  "definitionRevision": 3,
  "anonymous": true,
  "answers": [
    { "questionId": "q_age", "value": 20 },
    { "questionId": "q_fruits", "value": ["opt_apple", "opt_banana"] },
    { "questionId": "q_note", "value": null }
  ]
}
```

expectedUserId 只用于防止恢复登录后意外换账号，服务端实际身份始终来自会话。答案仅包含最终路径内内容，不发送完整缓存/历史；可选路径题缺省可补为 null，客户端不发送 path。匿名方式须符合问卷的强制/可选/禁止匿名模式，次数限制按登录账号执行，匿名提交也受约束。

### 4.1 字段与重试细则

GET填写data字段为 `{id,slug,title,description,settings,questions,deadlineAt,definitionRevision}`；不返回ownerId、revision、冻结标记、内部用户身份或已有答卷。关闭/到期409，草稿/不存在404；GET与POST均先校验登录，POST还要求CSRF。

POST 顶层五个字段均须提供；requestId 为 UUID（统一为小写），expectedUserId 为 24 位十六进制字符串，definitionRevision 为正安全整数，anonymous 为 boolean，answers 为数组。答案条目仅允许 questionId/value，value 缺省视为 null。基本格式错误、非有限/不安全整数、重复题目/重复多选成员返回 400；未知题目、答案题型或范围不符返回 422 ANSWER_INVALID；固定答案循环返回 422 PATH_NOT_COMPLETE，路径外附加题返回 422 ANSWER_OUTSIDE_PATH。数字字符串不转换为数值；含未配对 UTF-16 代理项的文本返回 422。服务端拒绝 path、respondentId、singleOnly 等客户端字段。

幂等标识按问卷、登录账号、requestId 唯一。同标识不同规范化内容返回 409 IDEMPOTENCY_CONFLICT。摘要包含 definitionRevision/anonymous/answers，条目按题目 ID、数组按选项 ID 排序；空字符串/纯空白/空数组/null/缺省 value 统一为空，非空文本原文保留，-0 与 0 相同。缺省整条答案和显式 null 条目视为不同请求；重放前仍验证原值与冻结题型相符。

成功 data 仅含 submissionId、submittedAt、replayed，同请求返回同一答卷 ID。首次新增返回 201，成功重试返回 200；问卷仍存在时，成功重放优先于关闭/到期拒绝。示例：

```json
{"data":{"submissionId":"000000000000000000000002","submittedAt":"2026-10-22T08:00:00.000Z","replayed":false}}
```

唯一冲突及并发业务拒绝后先在事务外查询同请求成功结果，再区分幂等冲突和次数限制。新增提交在每次事务尝试读取问卷后，按服务端时间重新检查状态、截止和定义版本；预先打开页面不构成受理。已受理的后续提交可在关闭后完成，冲突重试须重新受理；首份冻结和插入在同一事务完成，提交确认后才返回 201。

未知数据库/事务异常及提交确认失败返回 503 TEMPORARY_UNAVAILABLE，不能据此判断是否保存。客户端冻结原请求标识和负载，提示“提交结果待确认，请重试确认”。结果未知后，后续关闭/截止等错误不能证明原在途事务失败，仍保留原请求继续确认；明确的资源不存在按[整卷删除规则](#survey-deletion-api)处理。401/ACCOUNT_CHANGED 时保持原请求并同页恢复原账号，不能将答卷接管给新账号。

## 5. 统计和明细

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /surveys/:id/statistics | 作者 | 200，totalSubmissions 及各题统计 |
| GET /surveys/:id/questions/:questionId/statistics | 作者 | 200，该题统计 |
| GET /surveys/:id/questions/:questionId/answers | 作者；cursor、limit | 200，该题非空有效回答分页 |
| GET /surveys/:id/submissions | 作者；cursor、limit | 200，答卷摘要分页 |
| GET /surveys/:id/submissions/:submissionId | 作者，且答卷属于该问卷 | 200，完整最终有效答卷 |

### 5.1 统计与明细行为

本节5个GET均需登录及作者权限；草稿/关闭/到期不阻止作者读取。统计包括该问卷所有成功答卷，不按当前登录作者作为respondent过滤；不存在/越权问卷、非本卷题目、非本卷答卷统一404。

整卷与单题使用同一统计口径：answeredCount 仅计最终路径内的非空有效回答，数值 0 有效。选择题 count 为选项被选择的次数，percentage=count/answeredCount×100，零次选项仍列出；分母为 0 时 percentage=null，多选合计可超过 100%。数值题 average 不包含空答，无有效数值时为 null。接口不对均值和百分比提前舍入。

统计与明细采用服务端字段白名单，响应及分页游标排除账号 ID、respondentId、requestId、requestHash、singleOnly、会话与密码字段。匿名 respondent=null，实名仅为 `{username}`；账号关联缺失时也为 null。标题和说明从当前问卷读取，答案保留提交时的 definitionRevision。只读接口不修改问卷/答卷或延长会话，各次读取不承诺锁定同一快照。

### 5.2 响应结构与分页合同

先验证问卷所有权，非法/不存在/越权资源返回 404。非分页接口不接受查询参数，两个分页接口仅接受 cursor/limit；未知查询参数返回 400 INVALID_QUERY，无效游标返回 400 INVALID_CURSOR。

- 整卷data：`{survey:{id,title,description},totalSubmissions,questions:[QuestionStats]}`。
- 单题data：`{survey:{id,title,description},question:QuestionStats}`。
- QuestionStats：`{questionId,type,title,answeredCount}`，选择题再含`options:[{id,label,count,percentage}]`，数字题再含`average`。题目/选项按定义顺序保留；文本只需answeredCount及回答明细入口。
- 答卷摘要：`{submissionId,submittedAt,anonymous,respondent}`；逐题列表条目增加value。两个列表data均为`{items,nextCursor}`。
- 完整答卷data：`{survey:{id,title,description},submissionId,submittedAt,anonymous,respondent,definitionRevision,effectivePath,answers:[{questionId,value}]}`；题目/选项显示信息由已授权统计定义提供，不附交互历史。标题说明取本次读取的当前问卷。

分页默认 20、limit 范围 1—100；cursor 为 base64url JSON，严格仅含 `{surveyId,questionId,submittedAt,id}`。questionId=null 表示答卷列表，否则为指定题目；submittedAt 是规范 ISO 日期，id 为答卷 ObjectId。游标与当前资源不匹配返回 400，不能改变授权或携带用户身份。取 limit+1 并以 submittedAt/_id 降序翻页，末页 nextCursor=null；逐题列表只含该题非空有效回答。

## 6. 错误与处理

| HTTP / code | 场景与页面行为 |
| --- | --- |
| 400 INVALID_REQUEST / INVALID_BODY / INVALID_REVISION / INVALID_JSON / VALIDATION_FAILED | 正文格式、类型、字段或修订号非法；资源 ID 非法按资源查询约定返回 404 |
| 400 INVALID_QUERY / INVALID_CURSOR | 查询或分页参数非法 |
| 401 AUTH_REQUIRED / INVALID_CREDENTIALS | 登录缺失、到期或凭据错误；填写页恢复登录 |
| 403 CSRF_INVALID | 刷新会话 token 后按当前身份重试 |
| 404 NOT_FOUND | 不存在、草稿填写入口或作者无权访问 |
| 409 USERNAME_TAKEN | 用户名已被同样大小写的账号占用 |
| 409 ACCOUNT_CHANGED | 当前账号与 expectedUserId 不同，提示恢复原账号 |
| 409 REVISION_CONFLICT | 管理页 revision 过期，保留未保存编辑并提示重新加载/合并 |
| 409 DEFINITION_CHANGED | 填写页题目定义过期，提示重新载入填写 |
| 409 CONTENT_LOCKED / SETTINGS_LOCKED | 首份答卷后改题目，或首次发布后改填写策略 |
| 409 INVALID_STATUS / DEADLINE_PASSED | 状态不允许该操作，或重开时截止已到 |
| 409 SURVEY_NOT_OPEN | 已关闭或已到截止；此前打开页面不构成受理 |
| 409 ALREADY_SUBMITTED | 当前账号已用完一次提交机会 |
| 409 IDEMPOTENCY_CONFLICT | 同提交标识对应不同内容 |
| 409 SURVEY_STILL_OPEN | 问卷仍开放，不能永久删除 |
| 413 BODY_TOO_LARGE / 415 UNSUPPORTED_ENCODING | 请求正文过大，或字符集/内容编码不受支持 |
| 422 VALIDATION_FAILED / ANSWER_INVALID | 发布定义或答案不合法，details 定位字段/题目 |
| 422 PATH_NOT_COMPLETE / ANSWER_OUTSIDE_PATH | 最终答案未形成结束路径，或含路径外答案；不保存答卷 |
| 422 CONFIRMATION_REQUIRED | 删除确认文字缺失或不符 |
| 503 TEMPORARY_UNAVAILABLE | 数据库/事务暂时失败，保留相同请求标识和负载重试 |
| 503 SERVICE_UNAVAILABLE | 通用认证、数据库读取或其他服务故障 |

提交结果暂不确定时不能声称必然保存失败；同请求重试由幂等协议确认结果。通用认证或数据库故障也可能返回 SERVICE_UNAVAILABLE，同样保留原提交标识和负载。

<a id="survey-deletion-api"></a>

## 7. 删除整份问卷

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /surveys/:id/deletion-preview | 作者；无查询参数 | 200，data为`{id,title,revision,totalSubmissions,canDelete}`；canDelete按服务端状态及时间计算 |
| DELETE /surveys/:id | 作者、CSRF；正文`{revision,expectedUserId,confirmation:"删除"}`；无查询参数 | 204，无正文；仅在事务提交已确认后返回 |

预览允许作者查看任一自有问卷的删除资格，不修改状态或冻结字段；答卷数包含匿名与实名，每份成功答卷计一次，不返回填写者身份。预览不是提交快照，DELETE会再次验证并删除当时全部答卷，不以预览数量为删除上限。

revision须为正安全整数，expectedUserId须匹配真实会话且只用于防止换账号，confirmation须精确为“删除”。未知正文/查询字段或类型错误400 INVALID_BODY/INVALID_QUERY，非法revision400 INVALID_REVISION，缺失或文字不符422 CONFIRMATION_REQUIRED；缺失confirmation按确认失败处理。未登录401 AUTH_REQUIRED，CSRF沿用公共约定，账号不符409 ACCOUNT_CHANGED；非法ID、他人或不存在资源统一404 NOT_FOUND，不泄漏所有权或删除历史。

revision变化返回409 REVISION_CONFLICT，仍开放返回409 SURVEY_STILL_OPEN；这些错误均不删除任何记录。只有draft、closed，或published且服务端当前时间达到deadlineAt的问卷可删除。已有答卷不是拒绝条件。任何事务部分失败须全部回滚；数据库/提交确认异常503 TEMPORARY_UNAVAILABLE，前端提示“删除结果待确认”，不把503解释为必然失败。

通用认证或预览读取故障沿用503 SERVICE_UNAVAILABLE，不意味着资源不存在；页面亦不能据此完成删除确认。

重复删除已不存在的资源仍返回统一404，不声称知道其历史归属；页面仅在已验证原账号和原目标的流程中，将明确的资源不存在视为目标移除完成。网络中断后重试同一删除请求；资源仍在且revision/资格变化时重新预览确认，不能自动删除新版本。401/账号变化或普通读取故障不能当作目标不存在。

删除后，填写读取/提交返回 404 NOT_FOUND 和“问卷不存在或已删除”，成功提交的原 requestId 也不能恢复已删除数据。问卷仍存在但关闭/到期时，成功重放规则继续适用。未知提交结果遇到明确的资源不存在时终止确认；关闭/到期等其他错误仍保留原请求。作者管理、统计和明细对不存在资源返回统一 404，前端清除不可用内容。
