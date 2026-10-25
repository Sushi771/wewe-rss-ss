# 小红书订阅开发与交接

有界验收先检查首次订阅后的自动列表行为。新检查使用会继续返回游标的合成来源：两页提交后不得调用第三页，重进读取不得派发，明确续跑只从持久游标追加；同时检查请求计数和无凭据输出。正式联网结果须另以实际平台回执、同实例计数差值及本地正文/图片证据验收，离线回归不能替代它。

## 当前版本和结果

2026-10-24 固定公开源码 `9e1b81a8d095390bce968a137fd88d23ba5252df`。主负责人确认对应 r2 本机已上线、日常服务正常；本轮在隔离分支改进，不部署、不发真实请求、不读取凭据、不删除历史数据。

| 工作 | 当前状态 |
| --- | --- |
| 解析确认、列表/详情分离、分组/搜索/日期、共享前端、持久检查点及分批ZIP | 已实现；既有合成与浏览器证据见 [验收记录](ACCEPTANCE.md) |
| 严格主页parser、DPAPI、安全媒体 | 已集成；两种入口同作者复用订阅、32候选、3篇12图归档及重复保存零额外请求已核验 |
| 请求30返回32 | 公开修复接受最多60条响应；32全部保留、61整页拒绝已有合成反例 |
| 本机运行 | r2已上线；候选已纳入3处通用包装差异和单源组包，未再次部署 |
| 完整历史、持续更新 | 尚未验收 |
| 新改进 | 后台发现/核对/恢复关联、包装维护、6项独立正文图片检查及200b1b2整包恢复已通过；前端最终接线、真实HTTP恢复联调和备份状态现有界面对接已完成 |

## 维护入口

阅读 [产品标准](PRODUCT.md#深入改进的产品标准)、[交互设计](DESIGN.md)、[技术证据](TECHNICAL.md#原始证据与独立核对)及 [验收反例](ACCEPTANCE.md#深入改进反例与判定)。沿根AGENTS、[开发规范](../../DEVELOPMENT.md)和[前端原则](../UI_DEVELOPMENT_PRINCIPLES.md)，只改划归文件。

接口变动同步共享类型与前端，再更新技术表；尚在设计的任务发现/核对接口不提前写成已发布。复用模型、保存器、事务准入与共享组件；不把网络工作包入事务，不用自动重放掩盖回执丢失。

## 方法、工具与最小反例

| 方法与工具 | 本轮用途 | 必须保留的判定 |
| --- | --- | --- |
| Git固定SHA、diff及源码到包清单 | 区分公开源码、运行r2和改进候选 | 每处差异有来源；干净重建不依赖手工补文件 |
| Jest故障注入、临时Prisma/SQLite | 终态persist拒绝、写成后丢应答、取消收尾 | 分开验证执行器释放与持久状态核对，不因释放锁就重发 |
| Node合成请求计数及浏览器动作 | 页面刷新找回、状态失败、显式继续 | 原任务可追踪，查询不产生详情/下载请求 |
| 独立SQLite检查、正文比较器、图片解码器 | 原始内容到库、Markdown、图片的对照 | 不复用被测解析器生成期望；正文只允许转义/空白 |
| 独立临时目录及隔离端口恢复 | 从来源明确的包和合成恢复点启动 | 数据、任务及文图可用；没有新真实来源请求 |

基线反例已执行：把服务实现固定为 `9e1b81a`，沿真实临时SQLite及原保存器完成文件后使终态persist拒绝，pending未释放，断言失败；还原候选实现后同场景通过。独立用例又覆盖“恢复事务已写成但客户端未收到响应”和“初始入队写入失败而客户端无任务ID”，直接查SQLite行、旧新关联及来源计数，不能用一个内存状态替代这些证据。

页面反例按“提交→刷新→查询暂时失败→找回原任务→显式继续→终态后新选择”重现；同时观察任务ID、目标集合和请求计数。组包反例从缺少手工补件的干净副本启动，须定位缺失输入，不能借用运行目录文件让测试通过。实施窗口提供准确失败/修复命令后，父线程回填 [验收表](ACCEPTANCE.md)。

## 针对性回归入口

以下命令仅在隔离工作区和合成数据库运行，Prisma生成不能覆盖其他窗口依赖：

```sh
pnpm --filter server exec jest --runInBand xhs- xiaohongshu-contract xiaohongshu.service management-groups xiaohongshu-ui article-local-save
node --test scripts/xhs-subscription-ui.test.cjs scripts/manual-refresh-progress-ui.test.cjs scripts/feed-reading-ui.test.cjs scripts/feed-export-date-ui.test.cjs scripts/folder-navigation-ui.test.cjs scripts/article-date-shortcuts.test.cjs scripts/xiaohongshu-refresh-ui.test.cjs
pnpm --filter server exec prisma generate
pnpm build:server
pnpm build:web
```

共享组件同时回归公众号与小红书。测试工具代理每次渲染变化、查询丢失、取消收尾和终态新选择；先复现失败再验证修复，不用总通过数量代替覆盖。恢复与组包新命令由负责窗口确认后加入 [本机维护入口](../LOCAL_RELEASE_REHEARSAL.md)。

## 交付和待回填

每项实现交接准确SHA、文件、接口、原始合成输入、失败反例、修复后结果与独立检查。公开文档只保留去敏材料类别及结论，不提交用户身份、原文、签名链接、私有路径、真实回执或本机审计。

本轮后台、独立内容检查及200b1b2整包恢复证据已回填 [验收表](ACCEPTANCE.md)；前端结果与真实HTTP契约检查已补齐，整包恢复证据仍限定200b1b2。主负责人统一发布draft PR；禁止因文档写“r2已上线”而再次部署或恢复采集。当前周期备份暂停及发布恢复点的状态见 [维护说明](../LOCAL_RELEASE_REHEARSAL.md#当前本机状态与深入改进维护边界2026-10-24)。

独立内容检查只需运行 `pnpm --filter server exec jest --runInBand xhs-content-integrity.spec`。测试需要Python和Pillow，解释器可由 `XHS_TEST_PYTHON` 指定；缺失解码器会失败，不跳过或退化成只读图片头。XHS专用Windows/Linux CI沿既有 `actions/setup-python@v5` 约定选择Python3.12，通过官方PyPI安装固定 `Pillow==12.1.1`，仅用于测试；本机已用Python3.14/Pillow12.1.1执行6项通过，远端矩阵结果仍需发布后确认。源码未新增生产依赖。

最终联调使用真实@trpc/client通过随机loopback端口调用实际路由，临时SQLite承担持久化；仅外部来源使用合成adapter。它先复现“核对后仍被前端未知代码阻挡”的失败，再确认未知时不执行、核对后显式继续、旧新关联、取消重进不重放。维护只读状态检查与storage-status-ui测试进入同一Windows/Linux CI。
