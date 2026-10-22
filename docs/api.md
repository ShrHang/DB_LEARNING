# API 约定

状态：账号、第3节问卷管理、第4节填写提交、第5节统计/明细及第6节永久删除均已实现并通过用户验收。M4交付见[索引](../workflow/plan.md#m4)，M5见[索引](../workflow/plan.md#m5)，第4轮已提交8f0c5fc；[删除交付](../workflow/plan.md#deletion-discussion)已验收，待用户提交第5轮。M6已规划，尚未执行。业务依据见 [requirements.md](requirements.md)，实现流程见 [design.md](design.md)。所有路径以 `/api` 开头，由同一个 Express 应用提供。

## 1. 公共约定

- JSON 请求/响应；ObjectId 使用字符串，日期使用带时区 ISO 8601。
- 需要登录的接口使用 Cookie 会话；写接口使用 `X-CSRF-Token`。先通过 `GET /auth/csrf` 获取 token，登录成功后使用新会话 token。
- 成功通常返回 `{ "data": ... }`，204 无正文。失败返回 `{ "error": { "code", "message", "details": [] } }`。
- 字段白名单校验，未知或服务端专属字段拒绝；JSON/压缩正文解析和字段类型错误为 400，业务输入不合要求为 422；正文超过1MiB为413，不支持的字符集/内容编码为415。
- 作者资源查询限定 ownerId；资源不存在与越权统一 404。
- 管理更新在正文携带读取时的 revision；过时版本为 409，不自动覆盖。
- 分页默认 20 条，limit 可设 1—100，返回 items、nextCursor；游标包含稳定排序位置，不授予访问权限。此为技术默认参数，不是问卷答题次数限制。

## 2. 账号接口

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /auth/csrf | 无须登录，可建立 CSRF 会话 | 200，csrfToken |
| POST /auth/register | CSRF；username、password | 201，账号 ID、用户名、注册时间，不自动登录 |
| POST /auth/login | CSRF；username、password | 200，user、expiresAt、csrfToken，并设置新会话 Cookie |
| GET /auth/me | 登录 | 200，user、固定 expiresAt |
| POST /auth/logout | 登录、CSRF | 204，销毁当前会话并清 Cookie |

用户名和密码规则按 C6；密码含未配对 Unicode 代理项时422，不静默替换。凭据不匹配统一为 INVALID_CREDENTIALS，不返回哈希。注册 data 为 {id, username, createdAt}；登录和 me 的 user 使用相同白名单。未登录或固定期限到期为 AUTH_REQUIRED，401。

## 3. 问卷管理

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /surveys | 登录；cursor、limit | 200，仅当前作者的问卷摘要列表 |
| POST /surveys | 登录、CSRF；title/description 可为空，settings 显式选择 anonymityMode，allowMultipleSubmissions 默认 false | 201，新草稿、revision、definitionRevision 和分享链接 |
| GET /surveys/:id | 作者 | 200，完整管理定义及修订号 |
| PATCH /surveys/:id | 作者、CSRF；revision 及需修改的 title、description、settings、deadlineAt、questions | 200，更新后的问卷；按字段权限和 C3 校验 |
| POST /surveys/:id/publish | 作者、CSRF；revision | 200，校验成功后发布并冻结填写策略 |
| POST /surveys/:id/close | 作者、CSRF；revision | 200，关闭状态及新 revision |
| POST /surveys/:id/reopen | 作者、CSRF；revision | 200，重开状态及新 revision，须满足截止要求 |

M2 列表摘要为 {id, title, description, status, deadlineAt, createdAt, updatedAt}；无问卷时 items=[]、nextCursor=null。cursor 是创建时间及 ID 的 base64url 编码，只影响分页位置；ownerId 始终来自会话，未知查询参数或无效分页参数400。

管理 data 白名单为 {id, slug, title, description, status, settings, deadlineAt, questions, revision, definitionRevision, contentLocked, firstSubmittedAt, firstPublishedAt, createdAt, updatedAt, schemaVersion, shareUrl}，shareUrl 为相对路径 /survey/:slug，不返回 ownerId。

questions 采用完整数组提交以支持新增、删除和重排，数组中现有题目/选项的 ID 保持不变；结构见数据库文档。草稿允许未选条件、null条件值/目标和区间单边null；空操作符入库前规范为缺省。发布及首次发布后的编辑要求完整合法。题目实质变化才递增definitionRevision，单纯元信息/原样questions仅递增revision。status、ownerId、contentLocked、firstPublishedAt 等字段由服务端管理，不能通过 PATCH 任意覆盖。

## 4. 填写与提交

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /fill/:slug | 登录 | 200，当前开放问卷的标题/说明、填写策略、题目、deadlineAt、definitionRevision；草稿不开放 |
| POST /fill/:slug/submissions | 登录、CSRF；见下方请求 | 新增201；同请求成功重试200，均返回相同答卷 ID |

分享页面仍是 `/survey/:slug`；接口不暴露作者管理字段。无须逐题提交或保存进度接口，填写期间的校验和跳转由浏览器共享函数执行。

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

expectedUserId 只用于防止恢复登录后意外换账号，服务端实际身份始终来自会话。答案仅包含最终路径内内容，不发送完整缓存/历史。可选路径题缺省可补为 null，未知/重复题目及路径外附加答案报错；客户端不发送可信 path。

成功 data 包含 submissionId、submittedAt、replayed；不返回 respondentId、requestHash 或内部约束字段。同 requestId 不同规范化内容为 409。登录过期保持页面并重新登录原账号，重试保留原标识和负载；服务端最终状态和时间决定新增提交能否接受。


### 4.1 M4字段与重试细则

GET填写data字段为 `{id,slug,title,description,settings,questions,deadlineAt,definitionRevision}`；不返回ownerId、revision、冻结标记、内部用户身份或已有答卷。关闭/到期409，草稿/不存在404；GET与POST均先校验登录，POST还要求CSRF。

POST顶层五个字段均须提供；requestId为UUID（大小写统一小写），expectedUserId为24位十六进制字符串，definitionRevision为正安全整数，anonymous为boolean，answers为数组。答案条目仅允许questionId/value，value缺省视为null。基本格式/类型错误、重复题目/重复多选成员400；未知题目、题型或范围不符422 ANSWER_INVALID；固定答案循环422 PATH_NOT_COMPLETE，路径外附加题422 ANSWER_OUTSIDE_PATH。数字字符串不转换为数值；含未配对UTF-16代理项的文本422，避免BSON编码时静默替换。服务端从会话取身份，拒绝path、respondentId、singleOnly等客户端字段。

摘要包含definitionRevision/anonymous/answers，条目按题目ID、数组按选项ID排序；空字符串/纯空白/空数组/null/缺省value统一为空，非空文本原文保留，-0与0相同。缺省整条答案和显式null条目视为不同请求。相同摘要也不能掩盖非法题型：重放前仍验证原值与已冻结题型相符。首次新增答卷201；成功重试200，示例：

```json
{"data":{"submissionId":"000000000000000000000002","submittedAt":"2026-10-22T08:00:00.000Z","replayed":false}}
```

唯一冲突及并发业务拒绝后先在事务外查同请求成功结果，再区分幂等冲突和次数限制。未知数据库/事务异常及提交确认失败为503 TEMPORARY_UNAVAILABLE，不能据此判断是否已保存；客户端冻结原请求和负载，点击“重试确认提交结果”。已有结果未知状态后，后续重试即使返回关闭/截止等4xx，也不能据此断言原在途事务失败；仍保留原请求并锁定继续确认。401/ACCOUNT_CHANGED仍保持原请求并同页恢复原账号，不能将旧答卷接管给新账号。首份冻结和插入采用同一事务，实际提交确认后才返回201。


## 5. 统计和明细

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /surveys/:id/statistics | 作者 | 200，totalSubmissions 及各题统计 |
| GET /surveys/:id/questions/:questionId/statistics | 作者 | 200，该题统计 |
| GET /surveys/:id/questions/:questionId/answers | 作者；cursor、limit | 200，该题非空有效回答分页 |
| GET /surveys/:id/submissions | 作者；cursor、limit | 200，答卷摘要分页 |
| GET /surveys/:id/submissions/:submissionId | 作者，且答卷属于该问卷 | 200，完整最终有效答卷 |

选择题统计包含 answeredCount、各选项 count、percentage；percentage 取 0—100 的百分数，分母 0 为 null，多选总和可超过100。数值题包含 answeredCount 和 average，无有效数值时 average=null。精度保留展示由页面处理，服务端不提前对均值和百分比截断。

匿名答卷响应使用 anonymous=true、respondent=null；实名使用允许展示的用户名对象。答卷 ID 是答卷标识，不包含账号关联字段。标题/说明从当前问卷读取。

### 5.1 M5统计与明细行为

本节5个GET均需登录及作者权限；草稿/关闭/到期不阻止作者读取。统计包括该问卷所有成功答卷，不按当前登录作者作为respondent过滤；不存在/越权问卷、非本卷题目、非本卷答卷统一404。

统计输出以问卷与题目/选项元信息、totalSubmissions、answeredCount、count/percentage及数字average为白名单；零次选项仍列出，空分母percentage=null，空数值average=null。整卷与单题使用同一统计口径；具体嵌套DTO见第5.2节，已按该合同实现。

答卷摘要字段为 `{submissionId,submittedAt,anonymous,respondent}`，逐题条目增加value；完整答卷包括最终answers与effectivePath，元信息显示当前问卷版本。匿名respondent=null，实名仅为 `{username}`；这些响应及分页游标均排除账号ID、respondentId、requestId、requestHash、singleOnly、会话及密码字段。页面不能通过接收原文档再隐藏字段来代替服务端过滤。

两个分页接口只接受cursor/limit，默认20、范围1—100，返回items/nextCursor；按submittedAt/_id降序读取，逐题列表仅包含该题非空有效回答。未知query/无效limit或cursor为400；游标编码与资源作用域见第5.2节，不能改变作者授权条件。只读接口不修改问卷/答卷或延长会话，各次分页/统计读取不承诺锁定同一快照。

### 5.2 M5实际DTO与分页合同

`createStatisticsService({db})`提供`get(userId,id,query={})`、`question(userId,id,questionId,query={})`、`answers(userId,id,questionId,query={})`、`submissions(userId,id,query={})`、`submission(userId,id,submissionId,query={})`，路由调用后统一包装data。resource ID非法/不存在/越权404；先验证所有权再处理作者查询，未知query400 INVALID_QUERY，无效游标400 INVALID_CURSOR。非分页GET不接收query。

- 整卷data：`{survey:{id,title,description},totalSubmissions,questions:[QuestionStats]}`。
- 单题data：`{survey:{id,title,description},question:QuestionStats}`。
- QuestionStats：`{questionId,type,title,answeredCount}`，选择题再含`options:[{id,label,count,percentage}]`，数字题再含`average`。题目/选项按定义顺序保留；文本只需answeredCount及回答明细入口。
- 答卷摘要：`{submissionId,submittedAt,anonymous,respondent}`；逐题列表条目增加value。两个列表data均为`{items,nextCursor}`。
- 完整答卷data：`{survey:{id,title,description},submissionId,submittedAt,anonymous,respondent,definitionRevision,effectivePath,answers:[{questionId,value}]}`；题目/选项显示信息由已授权统计定义提供，不附交互历史。标题说明取本次读取的当前问卷。

匿名respondent=null，实名仅含`{username}`；如实名账号关联缺失则null，不能以内部ID代替。数据库的内部字段不透传。分页默认20、limit1—100；cursor为base64url JSON，严格仅包含`{surveyId,questionId,submittedAt,id}`，questionId=null表示答卷列表，否则为指定题目。submittedAt是规范ISO日期，id为答卷ObjectId；游标与当前资源不匹配400，不能影响授权或携带用户身份。取limit+1并以submittedAt/_id降序翻页，末页nextCursor=null。

作者页面`/statistics.html?id=<问卷ID>`；统计/详情只读，登录失效可同页重登并重新加载原资源，换账号时重新校验作者权限。页面平均值/百分比最多显示2位小数（技术展示默认），接口保留未舍入数值；null显示暂无数据，0显示0。

## 6. 错误与处理

| HTTP / code | 场景与页面行为 |
| --- | --- |
| 400 INVALID_REQUEST / INVALID_QUERY / INVALID_CURSOR | 请求格式、类型或查询/分页参数非法；资源ID非法按资源查询约定返回404 |
| 401 AUTH_REQUIRED / INVALID_CREDENTIALS | 登录缺失、到期或凭据错误；填写页恢复登录 |
| 403 CSRF_INVALID | 刷新会话 token 后按当前身份重试 |
| 404 NOT_FOUND | 不存在、草稿填写入口或作者无权访问 |
| 409 USERNAME_TAKEN | 用户名已被同样大小写的账号占用 |
| 409 ACCOUNT_CHANGED | 当前账号与 expectedUserId 不同，提示恢复原账号 |
| 409 REVISION_CONFLICT | 管理页 revision 过期，保留未保存编辑并提示重新加载/合并 |
| 409 DEFINITION_CHANGED | 填写页题目定义过期，提示重新载入填写 |
| 409 CONTENT_LOCKED / SETTINGS_LOCKED | 首份答卷后改题目，或首次发布后改填写策略 |
| 409 SURVEY_NOT_OPEN | 已关闭或已到截止；此前打开页面不构成受理 |
| 409 ALREADY_SUBMITTED | 当前账号已用完一次提交机会 |
| 409 IDEMPOTENCY_CONFLICT | 同提交标识对应不同内容 |
| 422 VALIDATION_FAILED / ANSWER_INVALID | 发布定义或答案不合法，details 定位字段/题目 |
| 422 PATH_NOT_COMPLETE / ANSWER_OUTSIDE_PATH | 最终答案未形成结束路径，或含路径外答案；不保存答卷 |
| 503 TEMPORARY_UNAVAILABLE | 数据库/事务暂时失败，保留相同请求标识和负载重试 |

事务提交结果暂不确定时不能声称必然保存失败；页面提示“提交结果待确认，请重试确认”，同请求重试由幂等协议返回最终结果。填写提交已实现如下合同；第5节统计及明细亦已实现。通用认证或数据库读取异常也可能返回503 SERVICE_UNAVAILABLE，同样保留原提交标识重试。


删除整份问卷的E1—E7已实现并验收，第6节为实际合同，服务见[deletion-service](../src/services/deletion-service.js)。既有题目删除与问卷关闭/重开行为保留；M6按[交付计划](../workflow/plan.md#m6)等待本轮提交后开始。

<a id="survey-deletion-api"></a>

## 6. 删除整份问卷

| 方法/路径 | 权限及输入 | 结果 |
| --- | --- | --- |
| GET /surveys/:id/deletion-preview | 作者；无查询参数 | 200，data为`{id,title,revision,totalSubmissions,canDelete}`；canDelete按服务端状态及时间计算 |
| DELETE /surveys/:id | 作者、CSRF；正文`{revision,expectedUserId,confirmation:"删除"}`；无查询参数 | 204，无正文；仅在事务提交已确认后返回 |

预览允许作者查看任一自有问卷的删除资格，不修改状态或冻结字段；答卷数包含匿名与实名，每份成功答卷计一次，不返回填写者身份。预览不是提交快照，DELETE会再次验证并删除当时全部答卷，不以预览数量为删除上限。

revision须为正安全整数，expectedUserId须匹配真实会话且只用于防止换账号，confirmation须精确为“删除”。未知正文/查询字段或类型错误400 INVALID_BODY/INVALID_QUERY，非法revision400 INVALID_REVISION，缺失或文字不符422 CONFIRMATION_REQUIRED；缺失confirmation按确认失败处理。未登录401 AUTH_REQUIRED，CSRF沿用公共约定，账号不符409 ACCOUNT_CHANGED；非法ID、他人或不存在资源统一404 NOT_FOUND，不泄漏所有权或删除历史。

revision变化返回409 REVISION_CONFLICT，仍开放返回409 SURVEY_STILL_OPEN；这些错误均不删除任何记录。只有draft、closed，或published且服务端当前时间达到deadlineAt的问卷可删除。已有答卷不是拒绝条件。任何事务部分失败须全部回滚；数据库/提交确认异常503 TEMPORARY_UNAVAILABLE，前端提示“删除结果待确认”，不把503解释为必然失败。

通用认证或预览读取故障沿用503 SERVICE_UNAVAILABLE，不意味着资源不存在；页面亦不能据此完成删除确认。

重复删除已不存在的资源仍返回统一404，不声称知道其历史归属；页面仅在已验证原账号和原目标的流程中，将明确的资源不存在视为目标移除完成。网络中断后重试同一删除请求；资源仍在且revision/资格变化时重新预览确认，不能自动删除新版本。401/账号变化或普通读取故障不能当作目标不存在。

删除后，填写读取/提交返回404 NOT_FOUND和“问卷不存在或已删除”，成功提交的旧requestId也不能恢复已删除数据。此为E3/E6新增边界；问卷仍存在但关闭/到期时的成功重放规则不变。未知提交结果遇到此明确资源结果终止确认；关闭/到期等其他错误仍按M4保留原请求。作者管理、统计和明细请求对不存在资源沿用统一404，前端清除不可用内容。真实验证范围见[删除用例](test-cases.md#survey-deletion-tests)。
