# 公开合集到账号级目录：固定源码与现有样本复核

2026-09-30，C 线只读本机已保存的腾讯公开脚本、目标号旧合集 HTML/JSON，以及第三合集的**脱敏私有页链**；本轮没有请求目标页、合集页或 `publictag`，也没有读取或输出原文、完整文章 URL、私有第三合集 ID。研究问题限定为：**已知目标 `biz` 和一个官方合集，能否从现有一手代码或响应自动枚举该号全部合集/栏目？** 六页 54 个列表键已经证明第三合集自身能完整分页，不能预设其他合集能由它发现。

## 固定样本与实际发送点

- 腾讯[合集客户端 `album80ec10.js`](https://res.wx.qq.com/mmbizwap/zh_CN/htmledition/js/album/appmsg/album80ec10.js)，本机 2026-09-27 保存版 SHA-256 `e030ebc65a902d3f010c6466ada9bc8c3d520eefa5b42d960eb93471bd395fbd`。模块 `album/appmsg/album.js` 第 **380 行**（UTF-8 字符偏移约 **14729**）在 `a({type:"GET", dataType:"json", url:...})` 中真正发送 `/mp/appmsgalbum?action=getalbum&__biz=<window.biz>&album_id=<L.albumId>&count=<R.pageCount>`；正向续页从当前 `R.articleList` 末条追加 `begin_msgid/begin_itemidx`。第 **70、79 行**初始化 `pageCount=10` 和 `articleList=L.articleList`；第 **225 行附近**的分享链接仍由同一个 `L.albumId` 构成，未寻找其他 ID。该脚本里 `/mp/...` 字面路径仅此一个；不存在已审版本中的 `getalbumlist`、按 `biz` 查询所有 `album_id` 的发送代码。这是**这个脚本的边界**，不能推成腾讯所有客户端均无该能力。
- 同版合集脚本第 **440 行**的合集头像/名称点击调用 `o.invoke("profile", {username:L.user_name, scene:"176"})`，是客户端原生 `profile` 调用，未产生可供独立服务使用的 HTTP 列表 endpoint、`hid` 或 `album_id`。第 **302 行附近**的 `L.mp_msgs` 只在页面预载非空时交给推荐组件渲染；脚本没有以 `biz` 请求 `mp_msgs` 的发送行。该组件代码未单独保存在本机，故不推断它在别的页面版本完全没有网络能力。
- 腾讯[文章脚本 `appmsg.muihhh087c466445.js`](https://res.wx.qq.com/mmbizappmsg/zh_CN/htmledition/js/assets/appmsg.muihhh087c466445.js)，2026-09-30 保存版 SHA-256 `97ef18b57ed7a313da9be9857f401514f8f73adff05fa92c5f6f161dc0905cd1`。它是压缩单行：偏移约 **70530** 的 `mp-album` 卡片把页面 `cgiData.album_info_list[]` 的 `link` 用作 `data-url`，只在 `link` 为空时回退到 `/mp/publictag?action=get&tag_id=<该条 tagId>&start=0`；偏移约 **68800** 的点击处理器对该 `data-url` 做页面导航。这里的 `albumId/tagId/link` 均须**先从已知文章页面获得**，没有“传 `biz` 取全部合集”的请求。八份 2026-09-27 已保存目标原文的 `album_info_list` 各只有一个已知合集链接且 `tagId` 为空；后来发现第三合集的那篇旧文章只私存其严格所属 `album_id`，未保存原始 HTML 或其他 `tagId`，不能从现有私有文件补出后者。
- 同一文章脚本偏移约 **150109、150801** 向 `/mp/relatedarticle` 分别发送 `action=precheck/directgetlist`，参数由**当前文章** `article_url/__biz/mid/idx`、页面 `has_related_article_info` 与场景等组成；返回 `list/more_url` 供文章推荐卡使用，已审发送点没有目标账号全集过滤、合集枚举或可复核 `hid/sn` 来源。偏移约 **127072** 的 `/mp/homepage` 只在外链分类/导航代码中出现，不由当前 `biz` 构造栏目目录请求。详见 [C 线既有静态分析](PUBLIC_PAGE_DISCOVERY.md#相关文章与页面导航新的腾讯端点尚未请求)；此处不重启同一 `relatedarticle` 或主页探针。

## `base_info.public_tag_link` 到底给了什么

2026-09-27 保存的两组目标官方 `getalbum` 首屏 JSON 均有 `base_info.public_tag_link`、`public_tag_content_num`。两个链接都是腾讯 `mp.weixin.qq.com/mp/publictag`、`action=get`，仅带数值 `tag_id`，**没有 `__biz`**；两个 `tag_id` 彼此不同，也分别不等于其来源的 `album_id`。其 `public_tag_content_num` 分别为 **5811** 与 **13**，对应合集自身 `article_count` 为 **13** 与 **19**，所以此字段不是合集文章数，也不能据它推导目标账号的文章或合集总量。它给出的身份是一个 Tag，而不是从 `biz` 枚举全部 Tag/合集所需的游标或目录；仅凭该链接也不能保证 Tag 页面只含目标号文章。[旧现场记录](../CHANNEL_INVESTIGATION.md#公开合集的真实多篇列表验证)将它归为跨号话题入口，但没有保存该 Tag 页逐条账号回包，因此这里以“账号范围未验证”为准。

目前仍保存的一份旧合集 HTML 中，`window.cgiData` 预载的是**当前** `albumId/articleList`；没有 `tagId`、`public_tag_link`、`mp_msgs`，`recomm_tag_page_url` 为空，页面 `<a href>` 也没有 `/mp/publictag`、`/mp/homepage` 或 `/mp/profile_ext` 目标。合集客户端脚本不读取 `public_tag_link` 这个字段；这不排除未保存的共享推荐模块或其他页面版本会呈现该链接。本机已保存的腾讯脚本中也**没有 `/mp/publictag` 页自己的列表请求模块**，所以当前只追到文章卡导航与旧 JSON 给出的 Tag URL，无法据此声称 Tag 页内部如何分页或过滤账号。第三合集的六页探针只原子保存了 `msgid/itemidx/create_time/sn/chksm`、游标、账号和哈希，**没有保存首屏原始 `base_info`**；因此不能声称第三合集有或没有 `public_tag_link/tag_id/recomm_tag_page_url`，也不为补此字段重取已完成的六页。

| 路径                    | 真实发送/导航与必需来源                                                                                                                 | 对“全号合集枚举”的结论                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 已知合集列表及续页      | 合集客户端第 380 行的 `GET /mp/appmsgalbum?action=getalbum`；必需**一个已知** `album_id` 与 `biz`，续页需要当前合集末条 `msgid/itemidx` | 三合集分别能分页；请求本身没有返回或查询该号其他合集 ID 的已证字段。                        |
| 文章中的所属合集卡      | 文章脚本偏移 70530 的 `data-url` 导航；必需**文章页给出** `album_info_list.link/albumId`，否则要有效 `tagId`                            | 可从读到的文章发现它明示的合集；无法保证覆盖未被种子文章触达的合集。                        |
| 合集 `public_tag_link`  | 官方 JSON 直接给出 `GET /mp/publictag?action=get&tag_id=<响应原值>` 的导航种子；未在已审合集客户端发现读取或发送行                      | 指向特定 Tag、没有账号筛选参数；可验证 Tag 页实际范围，但现有证据不支持把它等同目标号全史。 |
| 合集头像/号名           | 合集客户端第 440 行 `invoke("profile", {username,scene})`                                                                               | 客户端原生动作，不是可独立部署的列表 API；账号主页线交 B 线核验。                           |
| 合集推荐 / 文章相关文章 | 合集脚本仅消费预载 `mp_msgs`；文章脚本请求当前文章键的 `/mp/relatedarticle`                                                             | 可能给有限推荐；没有账号全量/全部合集游标证据。                                             |

## 有区别的一次最小验证条件

`public_tag_link` 是**明确来源、明确腾讯 endpoint、与已测 `getalbum` 不同**的候选；其用途先限于判别 Tag 页范围。若总控认为有价值，可从一份旧目标官方首屏 JSON **原样读取**一个 `public_tag_link`，先核 HTTPS、腾讯 host、固定 `/mp/publictag`、唯一 `action=get/tag_id`、数值 `tag_id`，并检查该精确 URL 本机未尝试哨兵；随后只发**一次**匿名直连 GET，不带账号会话、不跟随跳转、不重试，12 秒与 2 MiB 上限。遇 3xx、验证码、限流或认证要求立即停，不探跳转目的。若 HTTP 200，只在内存中分类页面标记、静态文章链接的目标/其他账号计数、是否有明确的静态分页/账号筛选链接、是否出现**其他**目标合集 ID；只输出计数/布尔，不保存原始 HTML、标题、URL、Tag ID 或私有字段，也不自动进入分页。静态页面若引用新的腾讯 JS，其实际请求须另做源码审查，不能靠字段名推断。即使它返回目标文章，也要逐项核 `__biz/mid/idx` 与原文 `ct`，不能把 Tag 结果直接计入订阅验收。C 线**没有执行**该探针；在没有 Tag 页源码/响应前，也不将其列为已证全号目录。

本轮可明确排除的只是：**已审版本的合集客户端 `getalbum` 正向/反向分页、分享和 `profile` 调用，加上两份旧首屏 `public_tag_link`，均没有提供“仅以目标 `biz` 枚举全部合集”的现成请求。** 不能据此排除腾讯其他版本、其他公开页面或由更多已核目标文章发现新合集；六页 54 条仅属于第三合集，列表 `create_time` 不等于逐篇原文 `ct`。

### `publictag` 单请求分类探针：离线完成，未执行

[`publictag-page-one-shot.cjs`](../../scripts/collection-source-probe/publictag-page-one-shot.cjs)锁定 2026-09-27 旧第二合集首屏官方 JSON 的 SHA-256 `c3ae9cc7f53948632bac3d09c78e6cfae26fe03ce5c93d837aa77d55249a231b`，仅从其中 `base_info.public_tag_link` 读取请求 URL；不手写或猜 `tag_id`。它核 HTTPS 腾讯 host、`/mp/publictag`、唯一 `action=get/tag_id`、数值 Tag ID；原链接固定的 `#wechat_redirect` 片段不属于 HTTP 请求，去掉片段后以**实际请求 URL 的哈希**命名私有排他 `.attempted` 哨兵。另从既存私有第三合集来源文件读取精确 ID，只在内存中用于区分“已知三个合集”与页面里其他目标合集，日志和 Git 都不含该 ID。

缺少精确复审标志、旧 JSON 哈希不符、来源字段变形、私有 ID 缺失或哨兵已存在时请求数为零。通过后先原子排他建立哨兵，再**至多一次** Node 原生 HTTPS 直连 GET：不带 Cookie、代理或页面凭据，不跟随 3xx、不重试，12 秒/2 MiB；遇验证/限流、非 HTML、超限立即停且不读取跳转位置。HTTP 200 HTML 仅在内存中移除 `<script>/<style>/注释` 后检查静态 `href/data-url`：页面结构类型、可辨长链目标/其他账号计数、无法判号的短链数、同一 Tag 的静态分页与显式账号筛选链接、指向目标号的官方合集链接及**已知三个之外**的 ID 数量；不执行脚本、不抓后续页、不输出 Tag ID、URL、标题、正文或原 HTML。`false/0` 只表示这份静态 HTML **未见**该迹象，不能据此判定动态 JS 没有相应功能，也不能把静态短链自动算成不同文章。

离线 `preflight` 已核旧 JSON SHA、原链接形状、已保存**另一种**官方合集 HTML 不会误归类为 `publictag`，并用假网络 200 页验证跨号链接/同号链接、静态分页、账号筛选、目标其他合集计数及假 302 停止；结果 `requests=0`、新哨兵不存在。无复审标志的 `probe` 也以 `requests=0` 停止。**C 线没有在线执行。**

## `publictag` 唯一一次 200 的实际判别范围

总控随后对上述**精确旧官方 Tag 链接**只发一次匿名直连 GET：HTTP **200**，通过了 `text/html` 与 `<html>/<body>` 门禁，也未命中该探针的验证码/限流文本规则；静态分类为 `unclassified_html`。移除页面 `<script>/<style>/注释` 后，探针认可的 `href/data-url` 中可辨文章长链/短链、同 Tag 分页、显式目标账号过滤与其他目标官方合集链接均为 **0**。私有 `.attempted` 哨兵已建立；原始 HTML、完整 URL、响应头中的静态资源名和页面 JS **没有保存**，此 URL 不重发。`unclassified_html` 的含义是未命中探针预先定义的文章/合集/Tag 容器标记，**不能**据此断定返回的是空页、错误页或正常 Tag 页，也不能推断脚本动态加载的列表不存在。此次只排除“此 URL、此时点、匿名形状的响应中，静态 `href/data-url` 已直接暴露目标号列表/分页/其他合集”这一狭义假设；未排除 JS 渲染、其他公开页面或由更多目标文章发现合集。

为追客户端发送点，离线复核本机 2026-09-30 前保存的 **67 份**腾讯第一方 `mpres` 静态 JS 与其 `firstparty-manifest.json`：没有任何一份含字面公开页面路径 `/mp/publictag`；此前保存的文章脚本只把它作为卡片**导航**，合集脚本连此路径都未引用。本轮 200 响应又未留 `<script src>`，所以无法把该页绑定到一个固定 CDN bundle、核它实际是否发 JSON、用什么分页或认证；不以源码空缺猜接口。已保存的编辑器脚本中出现的 `/cgi-bin/publictag` **不是**公开 `/mp/publictag`：见下段。不同旧合集的另一个 Tag ID 虽可从既存 JSON 取得，但在没有新客户端代码或响应结构依据前只是**同形再请求**，本轮不探。

## 另一条真正存在的腾讯合集目录请求：仅发布者后台

缓存 manifest 中的腾讯[后台共享模块 `modules.6f91f80b.js`](https://res.wx.qq.com/mpres/zh_CN/htmledition/pages/modules~editor/editor_for_web1~home/index/index_gray~mallactivity/list/list~media/publish_history/pu~modules.6f91f80b.js)，SHA-256 `76e6451cc5b70ead4a96c5639389089a9c6270e17e4656a524dc7dc57d78632e`，字符偏移约 **5252**：`_.get({url:"/cgi-bin/appmsgalbummgr?action=list", data:{begin,count,sub_title,type,latest:1,need_pay:0,...}})` 真正请求合集列表；成功时读 `list_resp.items/total`，以已取得条目数推进 `begin`，直至累计数达到 `total`。腾讯[后台编辑器 `editor_for_web1.2bb8d327.js`](https://res.wx.qq.com/mpres/zh_CN/htmledition/pages/editor/editor_for_web1.2bb8d327.js)，SHA-256 `342ee9fee800a5465e0bf0ca5f798835e90fcea4d2826114ca99169e1d731bb6`，偏移约 **1079049**，也以 `E.get` 请求 `/cgi-bin/appmsgalbummgr?action=list&count=<perPage>&begin=<nextBegin>&type=<albumType>`，读取 `list_resp.total/items[].id`；偏移约 **1093331** 的编辑标签流程请求同一路径并读历史/推荐合集。这里确有**账号级合集枚举与分页代码**，区别于公开 `/mp/appmsgalbum` 的单合集列表。

但这三处都在 `mpres` 的**公众号发布者后台/编辑器**脚本里，通过后台 AJAX 包装器请求 `/cgi-bin`；请求形状没有“选择任意目标 `__biz`”参数。**根据代码所在后台上下文推断**账号范围由该后台登录会话决定，本轮没有接口回包复核此点。当前只有本人合法的读者登录及目标号公开文章种子，没有目标号的发布者管理权限或相应会话成功响应。因此该实现不能作为跨号订阅 Provider 或当前目标号探针，不用读者 Cookie 去试、不猜后台 token。它证明腾讯发布者后台**实现了**合集目录调用，不证明匿名目标号访问能力。

Tag ID 的一手来源也须区分：旧公开 `getalbum` 首屏 `base_info.public_tag_link` 直接给特定 `tag_id`；文章脚本的回退导航从该**篇** `album_info_list[].tagId` 读值；腾讯[后台模块 `modules.b986823a.js`](https://res.wx.qq.com/mpres/zh_CN/htmledition/pages/modules~advanced/menusetting/menusetting~advanced/menusetting4Web1~album/edit/edit~comment/comment_l~modules.b986823a.js)（SHA-256 `4eaf9dcfc01260c5df4d51bc8a3b2e4176d6c5eb02daf750ff88f473267465f7`）偏移约 **239671** 从发布者的 `public_tag_info.public_tag_list[].tag_id` 取公共 Tag，同时从 `appmsg_album_info.appmsg_album_infos[].id` 取**另一类**合集 ID。这是后台已有资料的消费，不是从 `biz` 计算 ID。编辑器偏移约 **1091949** 的 `o.get({url:"/cgi-bin/publictag?action=check_and_get_info&tagname=<输入文本>&article_type=<类型>"})` 用于编辑时校验 Tag 名称；它不是公开 Tag 页文章列表。以上均未给出可用于本次匿名 `publictag` 200 页的真实列表发送行。

下一步只有在**另一份正常取得并可保留静态资源 URL 的官方 Tag 页面**或公开第一方可固定版本脚本中，找到其实际列表 endpoint、认证来源和分页参数后，才值得设计不同于这次静态 HTML 分类的一次低频验证。当前不重发已试 URL，也不把发布者后台接口冒充读者可用能力。
