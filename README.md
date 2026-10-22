# 问卷系统

课程第一阶段项目，使用JavaScript ESM、Node.js、Express、MongoDB原生驱动和原生页面。M1—M5及[整卷永久删除](workflow/plan.md#deletion-discussion)已由用户验收，第5轮收尾待用户Git提交。[M6交付计划](workflow/plan.md#m6)已编写，待提交后开始，当前尚未执行M6或完成阶段报告。

## 环境

- Node.js 22.9+、npm；本轮实际使用 Node.js 26.12.0、npm 12.2.1。
- 本机安装 `mongod`；本轮实际使用 MongoDB 8.3.9。`mongosh` 仅用于人工排查，本轮版本 2.13.0。
- 项目独立 MongoDB：`127.0.0.1:27018`，副本集 `questionnaire-rs`，数据与日志在 `local/mongodb/`。启停脚本核对数据路径、端口和副本集名称，不操作其他实例。现有 27017 实例无需调整。
- 直接依赖精确锁定在 [package.json](package.json)，完整依赖树在 [package-lock.json](package-lock.json)。

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

打开 [本机页面](http://127.0.0.1:3000)，注册后登录，进入个人问卷列表。新账号列表为空；点击“创建问卷”，显式选择匿名策略后创建草稿，随后添加题目、选项、校验和跳转规则。保存草稿或补全后发布，可关闭/重开。发布后复制分享链接，填写者可在链接页面登录，逐题作答、回退修改，确认匿名方式后提交。到达结束页仍需确认提交；遇到登录过期可在原页恢复原账号，提交结果未知时使用原请求重试确认。刷新或关闭填写页会丢失未提交进度。作者可从个人列表或编辑器点击“统计与答卷”，查看整卷/单题统计、分页回答和完整答卷；匿名条目隐藏账号关联，实名显示用户名，关闭/到期后仍可查看。注册不自动登录；用户名区分大小写，密码中的空格原样保留。

`cp` 只在首次配置时执行，避免覆盖已有 `.env`。`.env`、`node_modules/`、`local/` 均不纳入 Git。本轮已在本地生成 `.env`，密钥不写入共享文档。

第5轮升级时先停止旧应用，再启动新版`npm start`；启动初始化会增加内部surveyGuards集合并为现有问卷幂等补建协调记录，不清除原问卷或答卷。不要让未接入协调的旧应用同时处理请求。

删除入口位于个人问卷列表：草稿、已关闭或已到期的自有问卷可删除，仍开放的问卷须先关闭。确认框展示标题及答卷数，必须输入“删除”再点击“永久删除”；问卷及全部关联答卷永久移除，无法恢复。网络中断时保留“删除结果待确认”，使用“重试确认”。原分享链接及已打开填写页再次提交时提示问卷不存在或已删除。

配置项见 [.env.example](.env.example)：HOST/PORT 为 HTTP 地址，MONGODB_URI/MONGODB_DB 为业务连接，SESSION_SECRET 至少 32 个字符，COOKIE_SECURE 本机 HTTP 使用 false。会话固定 24 小时，无访问续期；Cookie 为 HttpOnly、SameSite=Lax。若以后使用 HTTPS，再配置 Secure=true。

## 停止和排查

- 在运行 `npm start` 的终端按 Ctrl+C，应用停止接收请求并关闭连接；`npm run dev` 支持开发时重启。
- `npm run db:status` 核查项目实例和可写主节点；`npm run db:stop` 关闭本项目 MongoDB，不删除数据。应用与数据库分别启停。
- 再次 `npm run db:start` 可恢复已有项目实例/数据；初始化可重复运行，启动应用也会检查并补建缺失集合/索引。
- 缺少密钥、数据库连接失败、非副本集、端口占用或不兼容 validator/索引都会报错，不回退到内存、不清库。数据库日志在 `local/mongodb/mongod.log`。
- 27018 被其他服务占用时应先排查；脚本拒绝操作未通过归属检查的实例。初始化只自动兼容已交付 M2 的精确 surveys 校验器：允许草稿数字区间使用 null 占位；不重写数据，其余不兼容结构仍报错。自定义过的校验器不会被覆盖。

## 测试

先启动项目副本集：

```bash
npm run test:unit
npm run test:integration
# 或运行上述两组
npm test
```

测试通过 `TEST_MONGODB_URI` 可指定其他可写副本集；不会采用 `.env` 中的业务数据库名。每套创建唯一的 `questionnaire_test_<随机值>` 数据库，结束仅清理自己创建的库。集成测试使用真实 MongoDB 和 HTTP Cookie agent，不需要另开 `npm start`。

可选的真实浏览器检查需要本机 Chromium，无额外 npm 浏览器框架：

```bash
npm run test:browser
# 非默认浏览器路径时
CHROMIUM_BIN=/path/to/chromium npm run test:browser
```

该命令启动临时应用、测试库与独立浏览器目录，验证账号/列表、四题型编辑、草稿规则、发布/关闭/重开、冲突输入保留、分享填写/回跳/最终分支、原账号恢复、结果未知重试、统计/作者明细及360px页面；完成后关闭并清理。仅这个临时无界面浏览器使用 `--no-sandbox`，不更改日常浏览器配置。业务时钟可注入，测试可在不等待一天的情况下验证 24 小时边界。

最新全量回归：71单元、100集成、25真实浏览器测试通过（第5轮删除功能），见[实际证据](docs/test-cases.md#survey-deletion-results)。覆盖删除资格/权限、全部答卷清理、真实事务竞争与回滚、原受理语义、未知结果确认及旧页面清理；原M2—M5功能回归通过。第4轮统计证据保留在[原记录](docs/test-cases.md#15-m5-实际执行记录)。[删除用户验收](docs/test-cases.md#survey-deletion-acceptance)已完成；本次文档收尾不算复测，M6回归与报告仍待本轮提交后执行。

## 文档

- [需求与决策](docs/requirements.md)、[数据库设计](docs/database.md)、[后端设计](docs/design.md)、[API 合同](docs/api.md)。
- [开发计划与状态](workflow/plan.md)、[按轮次记录的 AI 日志](workflow/ai-log.md)、[协作约定](AGENTS.md)。
- [文档职责](docs/README.md)。

轮次由用户控制，Git 由用户提交；第二阶段将在已有结构和数据上增量扩展。
