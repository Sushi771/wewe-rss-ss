# WeWe 本次官方文章任务 0.1.2 诊断候选

候选回送未启用：用户已安装 0.1.1 并执行一次 MAIN 只读核验，结果停在组件首关；本次开发没有更新安装或执行新的实站核验。配对与持久站点权限未启用；本包不配置或启用任务传输，不能宣称真实未知短链/最新订阅已恢复。

MV3：`activeTab+scripting`；optional `http://127.0.0.1/*`、`https://mmbiz.qpic.cn/*`，没有主动权限申请。只有用户点击才运行。没有 Cookie/token/ticket/存储/请求拦截/调试器权限。密钥输入仅在当前 popup 内存，关闭即清除。

读取当前官方公众号文章业务字段的定点 MAIN projection、ISOLATED iframe 正文及已加载图片字节。MAIN 实站读取未核实；现有 CUA 只读上下文看不到 Vue 属性，不能证明扩展 MAIN 的可用性。缺关联/canonical/可信时间/完整性/图片时停止，不猜参数、不解验证码、不解除后台停止。

源码与完整设计：[EDGE_OFFICIAL_TASK_EXTENSION.md](https://github.com/Sushi771/wewe-rss-ss/blob/codex/edge-official-task/docs/EDGE_OFFICIAL_TASK_EXTENSION.md)。配对和 routeVerified 必须由 owner 在用户确认与真实验收后配置，页面不能开启。审查包只有运行源码、只读 probe、本文及项目 LICENSE，没有第三方软件或真实文章。

0.1.1 的只读按钮执行一次 probe 后显示可选中反馈的逐项摘要：组件、业务关联、标题/来源匹配、身份与发布时间/canonical字段存在性、正文指纹存在与一致性、图片类别和显示加载计数。缺失/早退字段显示“未核实”，不作为“不匹配”。不显示 ID、URL、标题原值、HTML、正文、哈希或认证信息。DOM 与已返回正文一致不证明上游全篇完整；图片显示已加载不证明原始字节或完整保存。不会自动重试或申请权限。旧 0.1.0 审查 ZIP 保留不变。

0.1.2 仅细化组件首关诊断：区分根 Vue 属性/实例、组件选项与名称是否存在；只对已审计的 bookInfo/currentChapter/mpRawData 检查属性是否定义，不读业务值、不遍历组件树。名称缺失显示未核实，只有非空名称确实不是 MpReader 才显示未匹配。不显示名称原值。严格 MpReader 定位门禁与 projection 不变，未证明实站定位已修复。新实站核验须由父线程与用户安排，本次开发不执行、不自动重试；原已核 0.1.1 包不修改。
