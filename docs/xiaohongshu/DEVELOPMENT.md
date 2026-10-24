# 小红书订阅开发与交接

## 当前版本和结果

2026-10-24 按集成HEAD `a249be1` 及最终聚焦修复校准；原始基线 `f609bda0334f17f6c28ff84020d31cd5c47f3417`。后台检查点、默认关闭的原生来源、跨作者搜索和共享前端已合入，最终准确结果见 [ACCEPTANCE](ACCEPTANCE.md)。

| 工作 | 状态 |
| --- | --- |
| 解析确认、分组、仅列表/详情分离 | 已实现，后台合成验证 |
| 持久任务、持续列表枚举、取消/显式续跑 | 已实现，合成验证 |
| 共享订阅组件、搜索日期排序、跨批选择 | 已实现；支持全部/分组/作者及可见正文搜索 |
| 筛选/本博主全部ZIP，每100篇一包 | 已实现；合成浏览器205篇三批验证 |
| 聚焦合成、两端TS、定向lint及前端build | 已由集成负责人执行；准确集合见验收记录 |
| 原生来源、DPAPI、安全媒体接线 | 已集成并做合成验证，真实访问默认关闭 |
| 真实主页schema、账号小批验收 | 待用户授权；没有新增真实订阅验证 |
| 生产部署 | 未执行 |

## 维护入口

先读 [产品及功能对照](PRODUCT.md)、[交互设计](DESIGN.md)、[接口与任务架构](TECHNICAL.md)和[验收记录](ACCEPTANCE.md)，遵守根AGENTS、[根开发指南](../../DEVELOPMENT.md)及[前端原则](../UI_DEVELOPMENT_PRINCIPLES.md)。

修改后端接口先同步前端及 `packages/shared/src/xhs-subscription.ts`。复用既有模型、分组、保存器和事务协调；不要把网络工作包入数据库事务。任务迁移是追加表，部署前仍需按原迁移流程在隔离副本验证；不得把源码合并当作已迁移生产。

修改共享控件同时回归公众号、小红书。轮询effect由任务ID驱动，以ref访问每次渲染可能变化的工具代理；终态停止轮询，保留用户后续选择。取消时等待执行器释放，续跑使用旧ID请求、新ID跟踪，下载目录须一致。

## 针对性回归入口

以下为源码中的维护入口。Prisma须在隔离工作区生成，不覆盖其他窗口共享的node_modules；测试使用临时数据库。

```sh
pnpm --filter server exec jest --runInBand xhs- xiaohongshu-contract xiaohongshu.service management-groups xiaohongshu-ui article-local-save
node --test scripts/xhs-subscription-ui.test.cjs scripts/manual-refresh-progress-ui.test.cjs scripts/feed-reading-ui.test.cjs scripts/feed-export-date-ui.test.cjs scripts/folder-navigation-ui.test.cjs scripts/article-date-shortcuts.test.cjs scripts/xiaohongshu-refresh-ui.test.cjs
pnpm --filter server exec prisma generate
pnpm build:server
pnpm build:web
```

用合成来源、临时SQLite和独立输出目录验证，默认来源不因测试启用。前端TypeScript及lint沿现有package命令定向运行；只格式化本轮文件，避免全库fmt产生无关修改。

## 接下来的校准点

- 默认工厂尚缺已核实的主页profile parser；授权后取得一次有界资料响应，按稳定作者ID核实schema再接入，不能以合成parser替代。
- 旧单篇测试登录不会自动导入正式应用。正式路径为SQLite目录下的 `.wewe-xhs-session/session.dpapi`；首次会话交接、此用途及位置须明确确认，之后可显式恢复/断开。
- 来源解析与连接请求禁用通用前端日志；不要在错误、URL、测试夹具或文档中加入真实分享令牌和会话值。
- 页面每20条追加渲染，但notes全量返回；后续若优化服务端分页，须同步完整筛选范围、跨批选择和ZIP测试。
- ZIP范围在前端查询后冻结ID，并非服务端持久快照；100篇分包不保证每包小于25MB。超限失败提示及更小批次策略仍需按实际需求验证。
- 原生目录选择、完整键盘路径、真实主页schema及账号小批正文/图片/自然增量仍需对应证据。

主负责人统一检查公开差异、推送draft PR并核对CI；本次聚焦审查不推送、不部署，真实验收待明确授权。后续每次交接记录精确commit、变更范围、测试与已知限制，按 [ACCEPTANCE](ACCEPTANCE.md)更新状态。
