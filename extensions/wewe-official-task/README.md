# WeWe 本次官方文章任务 0.1.0 审查包

候选源码未启用：没有浏览器安装、开发者模式、配对或持久站点权限授权。安装需用户另行确认，当前 WeWe 没有注册任务路由或原按钮接线。不能宣称真实未知短链/最新订阅已恢复。

MV3：`activeTab+scripting`；optional `http://127.0.0.1/*`、`https://mmbiz.qpic.cn/*`，没有主动权限申请。只有用户点击才运行。没有 Cookie/token/ticket/存储/请求拦截/调试器权限。密钥输入仅在当前 popup 内存，关闭即清除。

读取当前官方公众号文章业务字段的定点 MAIN projection、ISOLATED iframe 正文及已加载图片字节。MAIN 实站读取未核实；现有 CUA 只读上下文看不到 Vue 属性，不能证明扩展 MAIN 的可用性。缺关联/canonical/可信时间/完整性/图片时停止，不猜参数、不解验证码、不解除后台停止。

源码与完整设计：[EDGE_OFFICIAL_TASK_EXTENSION.md](https://github.com/Sushi771/wewe-rss-ss/blob/codex/edge-official-task/docs/EDGE_OFFICIAL_TASK_EXTENSION.md)。配对和 routeVerified 必须由 owner 在用户确认与真实验收后配置，页面不能开启。审查包只有运行源码、只读 probe、本文及项目 LICENSE，没有第三方软件或真实文章。
