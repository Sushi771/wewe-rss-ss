# 订阅列表与刷新结果读取

文章列表以前取出完整 `contentHtml`，再计算 `bodyCached` 并移除正文。现在只读取原有列表元数据，并在同一个 Prisma 事务快照内查询这些文章的正文存在性。空字符串与 null 仍为 false，空白字符串和已有正文仍为 true；已标记不可用但保留的旧正文不会被改写或隐藏。详情、正文重试、导出和下载继续使用原正文查询。

公众号刷新与批量刷新完成后，原有公众号列表重读、文章列表 reset、汇总 invalidate 并行发起，保留全部缓存操作及原查询键。它们复用同一个已认证的 tRPC 客户端和现有 `httpBatchLink`，可共享一个批次；没有新增跨账号缓存、staleTime、轮询或原文重试。所选公众号 ID、排序、筛选与游标规则不变。

依赖直接复用已安装的 Prisma **5.10.1** 和 tRPC **10.45.4**，不升级或添加库。参考现有 [Prisma 事务](https://www.prisma.io/docs/orm/fundamentals/transactions)与 [tRPC v10 批处理](https://trpc.io/docs/v10/client/links/httpBatchLink)。对应开源许可证分别为 [Apache-2.0](https://github.com/prisma/orm/blob/main/LICENSE)和 [MIT](https://github.com/trpc/trpc/blob/main/LICENSE)。

## 对照与回归

私有 SQLite 副本上以相同排序、分页和字段做交替对照，比较实际候选函数与旧查询，逐项核对返回值一致。记录仅保存在忽略的性能证据中，不提交私有数据或样本统计；这些测量不代表生产请求、浏览器可见耗时或冷热启动时间。

公开回归使用合成 SQLite：null、空值、空白和大正文，公众号隔离，排序、搜索和游标，以及更新正文后的新结果。查询日志确认 SELECT 投影不传输正文；没有新增缓存，正文详情仍可读取。

前端回归编译实际刷新函数，并调用已安装的 tRPC 批处理链接，以合成 fetch 验证三项查询同批、不同认证客户端分开，以及一项失败时其他缓存操作仍已启动。合成延迟对照只证明批次数与等待方式，不宣称真实网络速度。

```powershell
pnpm --filter server exec jest article-list-page --runInBand
node --test scripts/refresh-feed-view.test.cjs
pnpm --filter server build
pnpm --filter web build
```

## 展示范围与限制

下载页面的忙碌提示改为本机操作，避免修改设置或取消时误称正在保存。批量查询的无权限提示复用现有 Sonner 的固定 toast ID，避免同一次认证失败堆叠多个相同提示；每个原认证错误处理与登录跳转仍执行。原页面的链接、目录和保存结果层级保留；账户仍优先显示真实平台昵称并区分保存名称与验证状态，订阅页原更新、阅读、选中后导出入口保留。本轮没有凭源码猜测重排整页。

主包存在静态导入多个页面的证据，但缺少受支持浏览器的解析、交互和小屏截图测量，未据此新增懒加载等待或布局变更。上述列表与批处理测量不作为冷热启动提速证明。

后续唯一 owner 将上述修补与 PR20 的只读端口检查并行整合为 `e3bd466`，准确 CI 四项及扩展离线回归通过。组合包完成隔离冷启动、故障注入回滚、受保护字段完整比对和独立 Python 检查后，已按原受控流程部署。官方来源及目录门禁继续禁用，定时关闭，上游停止状态保留。部署检查与真实页面视觉验收分别记录；PR21 的直接 CDP 历史测量不作为本窗口的受支持视觉验收，也不代表浏览器进程完全冷启动。
