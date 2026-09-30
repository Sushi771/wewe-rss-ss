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

`public_tag_link` 是**明确来源、明确腾讯 endpoint、与已测 `getalbum` 不同**的候选；其用途先限于判别 Tag 页范围。若总控认为有价值，可从一份旧目标官方首屏 JSON **原样读取**一个 `public_tag_link`，先核 HTTPS、腾讯 host、固定 `/mp/publictag`、唯一 `action=get/tag_id`、数值 `tag_id`，并检查该精确 URL 本机未尝试哨兵；随后只发**一次**匿名直连 GET，不带账号会话、不跟随跳转、不重试，12 秒与 2 MiB 上限。遇 3xx、验证码、限流或认证要求立即停，不探跳转目的。若 HTTP 200，只在内存中分类页面的 `biz` 过滤条件、当前 Tag 身份、条目账号是否跨号、是否返回**其他**目标合集 ID、是否有明确分页与真实发送代码；只输出计数/布尔，不保存原始 HTML、标题、URL、Tag ID 或私有字段，也不自动进入分页。即使它返回目标文章，也要逐项核 `__biz/mid/idx` 与原文 `ct`，不能把 Tag 结果直接计入订阅验收。C 线**没有执行**该探针；在没有 Tag 页源码/响应前，也不将其列为已证全号目录。

本轮可明确排除的只是：**已审版本的合集客户端 `getalbum` 正向/反向分页、分享和 `profile` 调用，加上两份旧首屏 `public_tag_link`，均没有提供“仅以目标 `biz` 枚举全部合集”的现成请求。** 不能据此排除腾讯其他版本、其他公开页面或由更多已核目标文章发现新合集；六页 54 条仅属于第三合集，列表 `create_time` 不等于逐篇原文 `ct`。
