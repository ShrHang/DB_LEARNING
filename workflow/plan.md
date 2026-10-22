# 开发交付索引

状态：用户已确认 M6 验收通过，M1—M6 及整卷删除均已验收。第6轮收尾就绪，待用户 Git 提交；项目报告由用户完成最终整理，不纳入 AI 待办。源码与公开文档已按当前系统整理，历史过程由 Git 和各轮日志追溯。

## 1. 成果与验收

| 里程碑 | 已验收成果 | 文件索引 |
| --- | --- | --- |
| M1 需求与架构 | 功能规则、数据模型、系统/API/测试设计 | [业务规则](../docs/requirements.md)、[系统设计](../docs/design.md)、[协作规范](../AGENTS.md) |
| M2 基础与账号 | 应用入口、数据库初始化、账号与固定会话、个人列表 | [成果](#m2) |
| M3 问卷管理 | 草稿、四题型、校验/规则编辑、发布、关闭与重开 | [成果](#m3) |
| M4 填写与提交 | 分享填写、回跳、最终路径、匿名、幂等与事务 | [成果](#m4) |
| M5 统计与答卷 | 整卷/单题统计、分页明细及匿名保护 | [成果](#m5) |
| 整卷删除 | 永久删除、精确确认、在途提交协调和页面清理 | [成果](#deletion-discussion) |
| M6 交付核查 | 运行复现、完整回归、公开文档整理及本地报告初稿 | [成果](#m6) |

<a id="m2"></a>

## 2. 基础与账号

[应用](../src/app.js)、[启动](../src/server.js)、[配置](../src/config.js)、[数据库初始化](../src/db/init.js)、[本机数据库脚本](../scripts/mongo-local.js)、[账号服务](../src/services/auth-service.js)、[账号测试](../tests/integration/auth.test.js)。

独立副本集、固定 24 小时会话、CSRF、大小写敏感账号、退出登录和个人列表隔离已实现并验收。

<a id="m3"></a>

## 3. 问卷管理

[管理服务](../src/services/survey-service.js)、[定义校验](../src/shared/definition.js)、[编辑器](../public/editor.html)、[管理测试](../tests/integration/surveys.test.js)。

草稿与完整校验、稳定 ID、定义/管理修订号、发布后填写策略冻结、首份后题目冻结和生命周期操作已实现并验收。

<a id="m4"></a>

## 4. 填写与提交

[填写页](../public/fill.html)、[答案校验](../src/shared/answers.js)、[跳转](../src/shared/rules.js)、[最终路径](../src/shared/path.js)、[提交服务](../src/services/submission-service.js)、[并发测试](../tests/integration/concurrency.test.js)。

页面缓存与实际导航、无限次交互回跳、有效分支筛选、原账号恢复、幂等重试、首份事务和关闭受理边界已实现并验收。

<a id="m5"></a>

## 5. 统计与答卷

[统计服务](../src/services/statistics-service.js)、[聚合仓储](../src/repositories/statistics.js)、[序列化](../src/serializers/submissions.js)、[统计页面](../public/statistics.html)、[统计测试](../tests/integration/statistics.test.js)、[权限与分页](../tests/integration/statistics-access.test.js)。

有效回答分母、数值平均、零/空值、分页、匿名输出和页面迟到响应处理已实现并验收。

<a id="deletion-discussion"></a>

## 6. 整卷删除

[业务规则](../docs/requirements.md#survey-deletion-requirements)、[数据库协调](../docs/database.md#survey-deletion-data)、[关键逻辑](../docs/design.md#survey-deletion-design)、[接口](../docs/api.md#survey-deletion-api)、[删除服务](../src/services/deletion-service.js)、[集成测试](../tests/integration/deletion.test.js)、[页面测试](../tests/browser/deletion.test.js)。

草稿/关闭/到期资格、输入“删除”确认、问卷/答卷/guard 原子清理、事务竞争与回滚、结果未知确认及资源失效处理已实现并验收。

<a id="m6"></a>

## 7. 交付与最终收尾

- [x] 已核对 `local/Phase 1.pdf` 第七节（PDF 第7—8页）：可运行代码/schema/配置、系统与设计文档、测试步骤/输入/输出/结果、报告九项内容均有对应材料。
- [x] 真实回归：72 单元、100 集成、25 Chromium 测试通过；环境及范围见 [测试结果](../docs/test-cases.md#results)。
- [x] 干净副本按锁文件离线安装 110 包，隔离库中完成真实 CLI/HTTP 启停、重复初始化、重启保留会话/数据/幂等及关闭删除验证。
- [x] 报告初稿已存 `local/report-phase-1.md`，被 Git 忽略；用户负责最终收尾。
- [x] 用户明确确认 M6 验收，README/docs 已精简为当前系统说明，AI 日志以本次交互为最后一条记录。
- [ ] 用户进行最终 Git 提交；后续报告整理及 GitHub 发布由用户处理，未由 AI 代为执行。

报告初稿覆盖项目目标、系统设计、MongoDB 设计、跳转设计、校验设计、AI 使用、测试结果、问题及解决方式。本地初稿不纳入 Git，最终报告由用户自行准备。

实际执行日期为 2026-10-22。运行复现只使用本次随机测试库和临时应用；测试资源已清理，开发库只读核对前后计数相同。本次最终文档整理未重跑程序测试，不将静态检查记作新的测试结果。

验证限制保留在 [测试说明](../docs/test-cases.md#results)：大规模删除压力、其他浏览器/平台、全部 Node 版本、真实 BFCache 及特定浏览器故障分支未完整验证，未做依赖安全扫描。

## 8. 过程记录

[AI 日志索引](ai-log.md)保留六轮真实交互及各次改动；M6 执行基线为用户第5轮提交 `f9f33c9`。测试与修正的详细过程见 [第6轮日志](logs/r6.log)，更早结果以相应日志和 Git 为准。

当前无后续里程碑实施计划。课程第二阶段未读取或实施；后续新工作需用户另行明确。
