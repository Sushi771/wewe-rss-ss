# 微信读书 MP 阅读器目录的 DOM 与分页路径（2026-09-30）

## 核查范围

只对腾讯公开静态资源做离线检索和格式化阅读；未请求任何目标公众号页面或列表，未读取本机凭据，未监听网络，也未复刻签名。`https://weread.qq.com/web/shelf` 当日 HTML 引用的 [`app.88f998b2.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/app.88f998b2.js) SHA-256 为 `996a561d9fb7f79bf4289a91e2b6f77dc617eb2bb9352c0320b33c87b9f3bf51`。其中 `/web/mp/reader/:infoId` 路由按需加载 [`17.237e2b08.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/17.237e2b08.js) 和 [`19.42e251bc.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/19.42e251bc.js)，SHA-256 分别为 `218bbe99f64fec0049bca80b5977f63c81580a860ea8706d22964901468101a5` 与 `85bea05005a543894c346a39cae5a234b9d77de322316b3a80e87de809af3a3e`。MP 列表调用、目录组件和页面渲染均在 `19`；`17` 未检出 `/web/mp/articles`、`fetchMpArticles` 或票据头字面量。两个 chunk 的 `.js.map` 在当日腾讯 CDN 返回 404。以下偏移为原始压缩文件的字符位置；本轮为阅读方便在系统临时目录格式化了副本，副本未提交。

**可导航 URL 形状**：同一第一方 `app.88f998b2.js` 偏移约 614300 定义 `mpReaderPage: '/web/mp/reader'`，约 614960 的 `mpReaderURL(bookId)` 返回 `mpReaderPage + '/' + e(bookId)`；约 615675 的 `parseReaderInfoId(infoId)` 验证并解码路由段，约 4102944 的路由声明使用 `/web/mp/reader/:infoId`。因此前端构造的是 `https://weread.qq.com/web/mp/reader/<由 bookId 编码的 infoId>`，并非把原始 `MP_WXS_*` 直接拼进路径。[GZHReader 的固定实现](https://github.com/zhiwuyazhe-fjr/GZHReader/blob/9cde7a4ce5dcda10e946d33551c91629916a9a8d/src/gzhreader_core/providers/weread.py#L51-L77)独立展示 `encode_weread_id(book_id)` 后才构造该路由；这只交叉核对形状，不等于本轮验证该 URL 对目标号可访问。未请求目标号，也未确认服务端是否兼容未编码路径；最小页面实验应从第一方已生成的合法导航链接进入，不能猜 `infoId`。

## 从 `reviews` 到可见页面

1. **页面初始化**：[`19.42e251bc.js`](https://cdn.weread.qq.com/web/wrwebnjlogic/js/19.42e251bc.js) 偏移约 376200–379000、440000–441000。页面从 `/web/mp/reader/:infoId` 解析 `bookId`，在 mounted 时派发 `FETCH_MP_INIT_DATA`；其中并行派发图书信息与 `FETCH_MP_ARTICLES`，随后按 `currentChapter.reviewId` 取正文。需正常登录和后端允许才能获得文章对象。

2. **列表响应进入内存**：同文件偏移约 445600–446400、约 455800 的 `UPDATE_MP_ARTICLES` mutation。`GET /web/mp/articles` 使用 `bookId` 和当前 `articles.length` 作 `offset`；成功回包的 `data.reviews || []` 原样追加到 Vuex `articles` 数组，未在此处先转成标题字符串。因此浏览器**内存**可能仍有服务端给的 `reviewId`、`mpInfo` 等字段；是否含 `mpInfo.originalId/time` 要以合法首屏真实回包核实。静态源码不能证明本目标可访问。

3. **目录 DOM**：同文件偏移约 462000–465800 的 `MpCatalog` render 与约 388700 的 `itemShowTime/itemShowSubTitle`。`<ul class="mpCatalog_list">` 按 `articles` 分组生成 `<li class="mpCatalog_list_item">`，再遍历 `subReviews`。首篇显示**组** `createTime` 的格式化文本、首篇 `review.mpInfo.title`、`pic_url` 和阅读/点赞数；同组后续篇显示标题、图片及统计，**没有逐篇时间**。标题是普通可点击 `div` 文本，键为数组序号；目录节点没有 `href`、`data-review-id`、`reviewId`、`originalId` 或原文 URL 属性。组时间也不能直接充当每篇原文发布时间。

4. **点击后的正文**：同文件偏移约 382000–383200、约 442000–443000、约 459900–460300。`handleClickMp` 使用点击闭包中的对象 `reviewId` 调 `/web/mp/content`，把成功内容赋给 `mpRawData`；渲染到 `<iframe class="mp_i_frame" srcdoc="...">`。目录点击处理本身未构造文章原文 `<a href>` 或把 `reviewId` 写入 DOM。`srcdoc` 中是否含稳定官方原文链接和 `ct` 无第一方静态保证，且正文需逐篇额外加载。

5. **翻页**：同文件偏移约 379200、383300–383600、约 462000 与 445600–446400。目录 `vue-custom-scrollbar` 的 `ps-y-reach-end` 只在目录已打开时触发 `handleScrollEnd → loadMoreArticles → FETCH_MP_ARTICLES`。成功页 `reviews` 追加到数组，下一次 offset 为数组组数。`showLoadMore` 计算值写死为 `true`，目录仅在有至少一组文章时显示加载占位；它**不是可靠的末页指示器**。请求失败会清加载状态，但没有给 DOM scraper 一个可验证的游标或总数。

## 能否只读 DOM 完成订阅

**纯可见 DOM 抓取目前不满足 Provider 身份门槛。** 列表可见标题、封面、组日期和统计，但没有每篇独立 `reviewId`、腾讯原文 URL 或逐篇发布时间；标题与图片 URL 都不适合作稳定文章键。逐项点击虽能让官方页面自然取正文，`iframe srcdoc` 是否含身份字段未证，且它仍没有自动给出所有文章的逐篇可靠日期。通过滚动触发下一页属于正常页面行为、不需监听或重放请求，但仅看目录 DOM 不能可靠判定末页，遇人工验证码必须停。由此只能说**本轮已审的目录 DOM 映射不足**，不能扩大成官方页面、WeRead Web API 或自建订阅全部不可用。

另有一条**尚未验证的非抓包研究线索**：Vuex mutation 保存的是完整 `reviews` 对象，正常授权浏览器的页面内存或许能只读取得原始 `reviewId/mpInfo.time/originalId`，由官方页面自行调用第一方 JS 和腾讯服务。读取页面内存不等于监听网络或重放签名，但它依赖未公开的 Vue 页面内部结构、腾讯发布的混淆脚本和有效登录；`document.querySelector('#app').__vue__` 是否能到达该 store、字段是否齐全、分页是否稳定，均未实测，不能写成产品能力，也不能绕开验证码。票据来源与人工边界另见 [票据生命周期](WEREAD_WEB_TICKET_LIFECYCLE.md)。

## 值得总控审查的最小实验条件

若总控确认有**不同于旧 `-2041` 请求的真实新认证上下文**，可在本人合法登录的官方浏览器中只读导航一次已经位于本人书架的 MP 阅读器页面，让页面自然发起首屏；不设置请求拦截器、不复制或重发 HTTP 头、不直接调用列表端点。首先只记录是否出现目录、条目数、`href/data-*` 与逐篇时间字段存在性，不保存原文或凭据。若页面自然出现验证码，由本人处理或停止；无人工完成时不继续。仅当正常页面成功加载后，再离线比较页面可见 DOM 与其 Vuex `articles` 对象是否含稳定 `reviewId/originalId/time`（先记录字段存在性与数量，真实值留在忽略的私有证据中）。若内存字段存在，另对五篇不同文章核对目标号身份、原文 URL/`ct`、分页和正文；若字段缺失或只支持首屏，精确排除这一 DOM/页面内存方案即可。此实验前不要用相同 Cookie 和脚本重发旧目标 `/web/mp/articles`。即使首屏可读，持续无人值守仍需证明 Cookie 自然续期、签名随官方页面每次请求正常生成、末页判定、长期运行和人工验证码时安全停机。
