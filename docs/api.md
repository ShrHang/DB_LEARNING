# API 初稿

状态：账号及本文件第3节全部问卷管理接口已实现并完成M2/M3验收；第4—5节填写提交与统计仍为 M4—M5 合同，尚未实现。M4计划见 [plan.md](../workflow/plan.md#m4)，本轮尚未实施。业务依据见 [requirements.md](requirements.md)，实现流程见 [design.md](design.md)。所有路径以 `/api` 开头，由同一个 Express 应用提供。

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

事务提交结果暂不确定时不能声称必然保存失败；页面提示“提交结果待确认，请重试确认”，同请求重试由幂等协议返回最终结果。填写提交的驱动异常分类、响应示例与完整字段 schema 在M4实现时补充；账号/管理已按前文实现，第4—5节仍不能当作已部署API。
