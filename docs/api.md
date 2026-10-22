# API 初稿

状态：账号及本文件第3节全部问卷管理接口已实现并完成M2/M3验收；第4节填写提交已实现并通过用户验收；第5节统计仍为M5合同。M4交付见 [plan.md](../workflow/plan.md#m4)，M5计划见[下一阶段安排](../workflow/plan.md#m5)，等待第3轮提交后实施。业务依据见 [requirements.md](requirements.md)，实现流程见 [design.md](design.md)。所有路径以 `/api` 开头，由同一个 Express 应用提供。

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

### 5.1 M5实施合同基线（尚未部署）

本节5个GET均需登录及作者权限；草稿/关闭/到期不阻止作者读取。统计包括该问卷所有成功答卷，不按当前登录作者作为respondent过滤；不存在/越权问卷、非本卷题目、非本卷答卷统一404。

统计输出以问卷与题目/选项元信息、totalSubmissions、answeredCount、count/percentage及数字average为白名单；零次选项仍列出，空分母percentage=null，空数值average=null。整卷与单题使用同一统计口径；具体嵌套DTO在M5-01固定后再派工，不能视为现有API返回。

答卷摘要候选字段为 `{submissionId,submittedAt,anonymous,respondent}`，逐题条目增加value；完整答卷包括最终answers与effectivePath，元信息显示当前问卷版本。匿名respondent=null，实名仅为 `{username}`；这些响应及分页游标均排除账号ID、respondentId、requestId、requestHash、singleOnly、会话及密码字段。页面不能通过接收原文档再隐藏字段来代替服务端过滤。

两个分页接口只接受cursor/limit，默认20、范围1—100，返回items/nextCursor；按submittedAt/_id降序读取，逐题列表仅包含该题非空有效回答。未知query/无效limit或cursor为400；游标的具体编码与资源作用域在M5-01固定，不能改变作者授权条件。只读接口不修改问卷/答卷或延长会话，各次分页/统计读取不承诺锁定同一快照。

## 6. 错误与处理

| HTTP / code | 场景与页面行为 |
| --- | --- |
| 400 INVALID_REQUEST | 格式、ID、类型或分页参数非法，提示对应字段 |
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

事务提交结果暂不确定时不能声称必然保存失败；页面提示“提交结果待确认，请重试确认”，同请求重试由幂等协议返回最终结果。填写提交已实现如下合同；第5节统计尚未部署。通用认证或数据库读取异常也可能返回503 SERVICE_UNAVAILABLE，同样保留原提交标识重试。
