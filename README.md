# 问卷系统

使用 JavaScript、Node.js、Express 和 MongoDB 构建的问卷系统，提供原生 HTML/CSS/JavaScript 页面。

支持注册登录、问卷编辑与发布、分享填写、条件跳转、答案校验、匿名提交、统计与答卷明细，以及问卷永久删除。

## 环境要求

- Node.js 22.9+、npm。
- 本机安装 MongoDB（`mongod`），使用支持事务的副本集。
- 默认项目实例为 `127.0.0.1:27018`，副本集名 `questionnaire-rs`，数据保存在 `local/mongodb/`。
- 浏览器自动测试需要本机存在 Chromium。

## 安装和运行

在项目根目录执行：

```bash
npm ci
cp .env.example .env
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {readFileSync,writeFileSync} from "node:fs"; const file=".env"; const text=readFileSync(file,"utf8"); if (/^SESSION_SECRET=$/m.test(text)) writeFileSync(file,text.replace(/^SESSION_SECRET=$/m,"SESSION_SECRET="+randomBytes(32).toString("hex")));'
npm run db:start
npm run db:init
npm start
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)，注册后登录。`cp` 仅在首次配置时执行，避免覆盖已有配置。

配置模板见 [.env.example](.env.example)：

| 配置 | 含义 |
| --- | --- |
| `HOST` / `PORT` | HTTP 监听地址与端口，默认 `127.0.0.1:3000` |
| `MONGODB_URI` / `MONGODB_DB` | 副本集连接地址与业务数据库名 |
| `SESSION_SECRET` | 至少 32 个字符的随机会话密钥 |
| `COOKIE_SECURE` | 本机 HTTP 使用 `false`；HTTPS 使用 `true` |

应用启动时检查配置、副本集和数据库结构，初始化可重复执行。配置、端口或数据库结构不兼容时会报错，不会清空数据。

按 Ctrl+C 停止应用；`npm run dev` 支持开发时自动重启。`npm run db:status` 查看项目数据库状态，`npm run db:stop` 停止项目实例。数据库脚本核对端口、副本集名和数据路径，不操作其他实例；日志位于 `local/mongodb/mongod.log`。

## 使用方式

1. 在个人列表创建问卷，设置匿名策略，添加单选、多选、文本或数字题，配置校验和跳转规则。
2. 保存草稿，补全后发布并复制分享链接。发布后匿名和重复填写策略固定；首份答卷成功后题目定义冻结，标题、说明和截止时间仍可调整。
3. 填写者登录后逐题作答，可返回修改、按规则回跳，到达结束页后确认提交。未提交内容只保留在当前页面，刷新或关闭会丢失。
4. 作者在“统计与答卷”查看整卷、单题统计及分页明细。匿名答卷隐藏账号关联；实名答卷显示用户名。
5. 草稿、已关闭或已到期的问卷可永久删除。确认框中输入“删除”并点击“永久删除”，问卷及全部答卷一并移除，无法恢复。

登录固定 24 小时有效，访问不续期；填写中到期可在原页重新登录原账号。提交或删除结果未知时使用页面提供的重试确认。

## 测试

先启动项目副本集，再执行：

```bash
npm test                  # 单元与真实数据库/HTTP 集成测试
npm run test:unit         # 仅单元测试
npm run test:integration  # 仅集成测试
npm run test:browser      # 真实 Chromium 页面测试
```

可通过 `TEST_MONGODB_URI` 指定其他可写副本集，通过 `CHROMIUM_BIN` 指定 Chromium 路径。测试使用独占的随机 `questionnaire_test_*` 数据库，仅清理本次创建的资源。

验证结果：**72 项单元、100 项集成、25 项浏览器测试通过**。环境、具体用例及未覆盖范围见 [测试说明](docs/test-cases.md#results)。

## 文档与目录

- [功能与业务规则](docs/requirements.md)、[系统与关键逻辑](docs/design.md)、[数据库设计](docs/database.md)、[API](docs/api.md)、[测试说明](docs/test-cases.md)。
- `src/`：后端及共享规则；`public/`：页面；`scripts/`：数据库管理；`tests/`：自动测试。
- [文档索引](docs/README.md)、[开发交付索引](workflow/plan.md)、[AI 协作记录](workflow/ai-log.md)。

`.env`、`local/`、`node_modules/`、`coverage/` 和本机代理配置不纳入 Git。
