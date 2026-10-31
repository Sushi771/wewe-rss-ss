# 小红书开发、维护与发布

按[产品](PRODUCT.md)、[设计](DESIGN.md)、[接口与数据契约](TECHNICAL.md)和[验收](ACCEPTANCE.md)维护现有实现。本页记录开发顺序、发布状态和原始材料入口；其他页面不重复维护一份完成清单。

## 本次交付状态（2026-10-28）

- 已安装基线：`7e8fa196608d90d35149847449984976ec0ef3b7`，依据既有安装回执；这不是本次重新查询运行进程的结果。
- 待交付源码：`9a5d3de7d2c9280254451a8bd65418a20ab3d349`。完整新包尚未生成，未完成新包运行验收或生产切换。本轮文档校订不改变该状态。
- 该头CI终态为5成功、1失败。Windows push的`automatic-media-storage.spec.ts:114:3`在beforeEach超过40秒，来源套件684/685通过；[原始运行40707938595](https://github.com/Sushi771/wewe-rss-ss/actions/runs/40707938595)。先定位现有夹具的连接、迁移和seed耗时，保留失败，不以增加超时、跳过或换工作流掩盖。
- 尚未取得本次完整新包的构建与运行回执；公开CI结果与包运行、安装及真实来源验收分别判定。本机故障时间线、登记状态和修复记录由维护者在私有材料中保存，不作为公共操作指南。

本次从7e8到9a的56项差异未改变依赖清单、lockfile、schema、迁移或`runtime.cjs`。这支持评估同schema更新和复用有效输入，不能替代旧任务document、队列及运行包兼容验证；旧版已存在scope/build-only/compact保护。

公开复核入口如下；运行回执和私人审计材料留在获准的本地证据区，不在此列出文件名或内部标识。

| 要核对的合同 | 项目内源码或合成测试入口 |
| --- | --- |
| 任务、累计额度及派发屏障 | `apps/server/src/collection/xhs-subscription.spec.ts`、`apps/server/src/collection/xhs-whole-source-fence.spec.ts` |
| 媒体保存及事务恢复 | `apps/server/src/collection/saved-media-writeback.spec.ts`、[事务恢复说明](../MEDIA_TRANSACTION_RECOVERY.md) |
| 组合筛选、排序与响应式布局 | `scripts/xhs-combined-filter.test.cjs`、`scripts/xhs-metric-sort.test.cjs`、`scripts/responsive-layout-browser.test.cjs` |
| 构建配对与保留更新 | `scripts/local-release/verify-source.cjs`、`scripts/local-release/reproducible-release.test.cjs`、`scripts/local-release/preserving-restart.test.cjs` |

测试入口说明可复验的方法，不代替某次安装或真实来源的运行回执。CI原件使用本节公开链接核对。

## 最小开发与独立复核

先绑定基线SHA和候选文件哈希，围绕一个真实失败建立最小反例，再修改受影响实现。复用现有Jest/Node、临时SQLite和浏览器夹具，按[验收](ACCEPTANCE.md)选择相关合同及必要共享回归；不把所有故障场景扩成每次发布的固定全量任务，不以测试总数替代覆盖。

受影响的API同步后台、共享类型和前端调用；优先使用已有契约，避免另写一份手工类型掩盖差异。诊断先保留固定错误和动作结果，不用新工具链替代修复与交付。

## 发布与回退

单一整合者冻结源码、前端资源、后端JS、完整SQL迁移和构建清单。源码哈希与包哈希分别正确仍不足，必须逐文件验证源码→构建配对，特别核SQL逐字节一致。记录同头CI结果、测试环境及未执行项；旧头绿灯不覆盖新差异。

先分清纯代码覆盖与数据迁移：恢复路径有效且覆盖范围已核实的同schema更新，可复用现有一致性恢复点，不因少量代码或文档修改机械复制整库。迁移、恢复逻辑变化或覆盖证据不足时，按[事务恢复说明](../MEDIA_TRANSACTION_RECOVERY.md)补相应一致副本/隔离演练，遵循现有空间策略；线上仅作有界短查询，连接在finally关闭。

构建入口及模式见[隔离构建](../ISOLATED_RELEASE_BUILD.md)和[保留更新合同](../PRESERVING_UPDATE.md)。只生成隔离输出不授权安装；先形成完整包及所需兼容证据，再审查安装和切换。真实旧ledger/adopted保持可追溯，不手改hash、清unknown或伪造空历史。新增安全guard须说明动作、对象与真实风险，不能因项目自建限制而无限扩建机制。

构建不调用`installPair`；安装阶段才按真实目录清单核对其既有`adoptLegacy`接口是否适用。不得猜测现场库存、虚列归属冲突或将安装前置倒灌给构建。

安装核源码/运行包身份、前端实际资源、迁移、启动健康和数据/用户文件保护，再分别安排获准的最小真实验收。二进制回退保留新增表、账本和用户文件；不做破坏性down迁移，不删journal/锁文件或清unknown换取启动。恢复失败、清理超时或结果未知保持暂停，明确下一步证据缺口，不自动重放来源。

## 维护交接

每项记录需求→实现位置→反例/命令→原始证据类别→结论及边界，标为已实现、待验证或待开发。固定错误与实际HTTP数值可公开说明；真实用户身份/内容、token、凭证、绝对路径、私有账本及本机审计仅留获准私有材料。公共文档写通用标准和合成例子，不复制私人验收过程。
