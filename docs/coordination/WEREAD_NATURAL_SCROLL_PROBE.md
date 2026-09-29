# 微信读书官方搜索页：首屏与首次自然滚动的离线探针（2026-09-30）

## 固定源码与本轮边界

本机只读克隆核对 [`KANIKIG/wechat-search-weread@ce5c78ebf71ad751c0035cac076dc87e9cb95c2b`](https://github.com/KANIKIG/wechat-search-weread/tree/ce5c78ebf71ad751c0035cac076dc87e9cb95c2b) 的提交号。其[备用 Python 脚本](https://github.com/KANIKIG/wechat-search-weread/blob/ce5c78ebf71ad751c0035cac076dc87e9cb95c2b/scripts/search_weread.py)先访问腾讯 `search.weixin.qq.com` 的微信读书搜索页，读取 `.search_list_item` 卡片；搜索页没有可直接从卡片 DOM 取出的原文 URL，作者靠逐条点击取得 URL。其[完整流程](https://github.com/KANIKIG/wechat-search-weread/blob/ce5c78ebf71ad751c0035cac076dc87e9cb95c2b/references/detailed-workflow.md#L185-L232)称首屏约 15 条，一轮用 **3 次** `scrollTo` 加显式 `dispatchEvent('scroll')`，再看到约 45 条增量。这是该作者的其他环境记录，**没有目标号当下回包**；一轮也不是一次滚动或一次 HTTP 请求。

本工作仅给[独立一次性脚本](../../scripts/research/probe-weread-natural-scroll.cjs)做离线预检和门禁，**未打开目标搜索页、未发送目标请求、未滚动目标页**。它与[直接 Web 搜索代理 POST 探针](WEB_SEARCH_BROKER_PROBE.md)是不同路径：这里观察官方页面自然呈现的首屏与首次滚动后 DOM 增量，既不直接调用 `/web/wx_search_broker_proxy`，也不监听、截取或保存页面网络报文。B 线负责来源和稳定性评估；本报告只定义可控的一次探针与其可判别范围。

## 执行门禁与请求上限

先由本人正常登录官方微信读书 Web，并在**同一已批准本机浏览器上下文**中打开、确认目标准确号名 `妈妈部落畅聊阁` 的官方搜索首屏。当前浏览器清单调用曾返回 `Browsers: Error: nodeRepl.fetch request failed`，无法确认现有已登录标签页；原有 `wrk-` Gateway Key 不是此页面会话。故本轮只运行 `--self-test` 和 `--plan`，不得执行 `--execute`。脚本不会启动浏览器、开放调试端口、登录、读取 Cookie，亦不将旧应用 Cookie 注入页面。CLI 的 `--confirmed-authenticated --confirmed-target-page` 表示操作者已在真实页面确认这两件事，缺少任一即拒绝执行。CDP 地址必须明确为本机 `http://127.0.0.1:<port>/` 或 `localhost`，且恰好找到一个 `search.weixin.qq.com` 页面；URL 有 `query` 参数时必须等于目标号名。官方重定向若隐藏参数，精确目标页仍须由操作者核对。

单次执行中脚本**主动发出的目标导航/搜索 POST/文章点击均为 0**；本机 CDP 清单读取 1 次、页面 DOM 快照最多 2 次、浏览器 `mouseWheel` **至多 1 次**，无翻页、换词、额外 `scrollTo`、合成 `scroll` 事件、重试或原文请求。滚动后只等待 8 秒并取一次快照。一次真实滚动可能使页面自行发送一个或多个内部 XHR；由于不监听网络，**内部 HTTP 请求数未知，不宣称为 1**。首屏已有卡片但页面无法滚动、已不在顶端、已有超过 30 卡片、可疑验证或搜索来源变化，均在滚动前或后停下。若单次 wheel 未产生可观察的真实 `scroll` 事件，或有事件但无新 `data-id`，分别记录“滚动未验证”或“无增量”，不补发合成事件。验证码、访问频繁等提示即停止。

## 仅允许的摘要与判读

输出只含首屏卡片数、`data-id` 字段存在数/去重数、卡片来源号名**精确匹配数**、日期文本的“缺失/绝对日期样式/相对日期样式/其他文本”计数，以及首次滚动后这些数值的新增部分、可见卡片数变化、真实 `scroll` 事件是否被观察和停止分类。`data-id` 只在进程内用于去重，既不输出原值，也**不预先认定为 canonical 文章 ID**。日期文本只是页面展示形状，不能当作原文 `ct` 的发表时间。没有原文 URL、目标 `biz`、正文或图片，故即使显示五个不同 `data-id` 也不能算目标五篇验收。一个搜索页首屏及一次增量同样不能证明全号近期覆盖或订阅前全史。

脚本不会打印或写入卡片标题、摘要、原文 URL、原始 HTML、Cookie/Key、CDP 页面 URL 或网络响应，也不写 SQLite。离线 `--self-test` 覆盖成功增量、首屏与增量分离、未触发真实事件、无增量、疑似验证、非首屏、目标查询/域名门禁、非本地 CDP 拒绝、白名单丢弃敏感附加字段及 DOM 快照形状，共 **17** 个断言；模拟目标请求和滚动均为 **0**。这只验证脚本门禁，不证明官方页面现在可用。当前继续条件是本人已有正常登录的官方目标搜索页可确认；没有该条件不执行在线探针。
