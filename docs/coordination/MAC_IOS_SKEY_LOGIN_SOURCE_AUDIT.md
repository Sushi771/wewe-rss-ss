# Mac/iOS 微信读书 `skey/vid` 正常来源专项（2026-09-30）

范围：只读审查公开源码、仓库历史、作者说明及腾讯 App 的商店资料。本轮没有读取本机私有凭据或日志，没有运行微信读书客户端，也没有向腾讯接口发送请求。此前 BOOX/EInk 正常登录、`syfun` 捕获分支和本人 `/book/articles` 的两次 `-2012` 已在[前一轮报告](BOOK_ARTICLES_CLIENT_AUTH_FOLLOWUP.md)限定，这里不重复实验。以下“未找到”只指本次列明的公开材料，不等于客户端不存在正常登录或所有后续研究已穷尽。

## 新发现：近期 Mac 项目从官方客户端**日志**读取凭据

固定 [`tanyaqiong31029/weread-shelf-organizer@7ffef5c`](https://github.com/tanyaqiong31029/weread-shelf-organizer/tree/7ffef5c0111103c746b53ea607acb798ee5b8903)（截至本次审查的仓库 HEAD；该提交的 CHANGELOG 记录 2026-09-06 的 1.2.1）。作者的 [README](https://github.com/tanyaqiong31029/weread-shelf-organizer/blob/7ffef5c0111103c746b53ea607acb798ee5b8903/README.md#L204-L225) 报告真实书架 2924 本、2888 次迁移，并说 macOS 用户安装 App Store 微信读书、本人登录一次即可自动提取凭据；Windows/Linux/CI 需自行提供 `WEREAD_VID/WEREAD_SKEY`。这是一手作者使用主张，仓库没有可核的原始服务器成功响应，且其任务是整理**本人书架**，不是公众号文章列表。

| 问题 | 固定源码证据 | 能得出的判断 |
| --- | --- | --- |
| 来源 | [`scripts/weread_shelf.py:39-78`](https://github.com/tanyaqiong31029/weread-shelf-organizer/blob/7ffef5c0111103c746b53ea607acb798ee5b8903/scripts/weread_shelf.py#L39-L78) 使用 `open -a` 启动官方 Mac App，再读取 `~/Library/Containers/com.tencent.weread/Data/Documents/log` 最新 `.log`；正则提取日志中的 `skey`、`vid` 和版本。 | 这是官方客户端**已输出值**的本地复制，不是第三方脚本生成 `skey/vid` 的正常登录实现，也不是网络抓包。腾讯客户端内部的签发请求与响应仍不可由该源码审查。 |
| 配对与时效 | 同一段代码对所有 `vid` 与所有 `skey` **分别**取最常见值；没有按一次登录/响应配对，也没有凭据有效期字段或签发时刻。 | 不能从“最新日志”推出取到的是最新、同会话或可续期的凭据。 |
| 实际发送行 | [`headers()`](https://github.com/tanyaqiong31029/weread-shelf-organizer/blob/7ffef5c0111103c746b53ea607acb798ee5b8903/scripts/weread_shelf.py#L80-L88) 把 `vid/skey/v/User-Agent` 放入对 `https://i.weread.qq.com` 的请求头；[`get_cred()`](https://github.com/tanyaqiong31029/weread-shelf-organizer/blob/7ffef5c0111103c746b53ea607acb798ee5b8903/scripts/weread_shelf.py#L133-L176) 首先用环境变量或日志凭据请求腾讯 `GET /shelf/sync?userFlag=0&synckey=&teenmode=0&album=1`。 | 可核验的端点是个人书架同步；没有 `/book/articles` 发送行或其当前成功响应。 |
| “续期”行为 | 上述 `get_cred()` 在 HTTP 失败后 `pkill -x WeRead`、重启客户端、重新读日志，最多重复两轮；[`http_json()`](https://github.com/tanyaqiong31029/weread-shelf-organizer/blob/7ffef5c0111103c746b53ea607acb798ee5b8903/scripts/weread_shelf.py#L106-L127) 仅以 HTTP 异常判断失败，HTTP 200 的业务错误 JSON 也会返回。 | 重启可能促使官方客户端自行登录，但源码没有续期协议、`refreshToken` 使用或续期成功判定。不能把它写成已审计、可长期维护的无抓包续期链。 |

本线索比 `syfun` 多出一个**非抓包的本地来源**，但它仍依赖官方 Mac 客户端运行及其非公开内部登录，且没有文章端点证据。它不证明 Mac 凭据与此前 BOOX/EInk 的权限不同，也不证明权限相同。当前用户环境是 Windows；[腾讯 Apple 商店页面](https://apps.apple.com/cn/app/%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6/id952059546?platform=mac)把该 App 列为需要 macOS 12、Apple M1 或更新芯片的 Mac 应用。这只是可安装性资料，不能由平台名称推断 `skey` 的授权范围。

## 其他 Mac/iOS 开源实现的实际认证形状

| 一手材料 | 实际做法 | 对本问题的界限 |
| --- | --- | --- |
| [`ZiyaoZhangforPCL/WeReadMac@fc0dccf`](https://github.com/ZiyaoZhangforPCL/WeReadMac/tree/fc0dccf209734bc69d8925301720c2ca2408fee2) 的 Swift `WKWebView`、[`Ljhhhhhh/weread-drawer-macos@3ae86c2`](https://github.com/Ljhhhhhh/weread-drawer-macos/blob/3ae86c26cbb57105fc97e4e45db2151628425675/Sources/main.swift#L577-L580) 和 [`TangHuaiZhe/WeReadMacElink`](https://github.com/TangHuaiZhe/WeReadMacElink) | 嵌入 `https://weread.qq.com`，使用网页会话或网页数据存储。`weread-drawer-macos` 的[加载行](https://github.com/Ljhhhhhh/weread-drawer-macos/blob/3ae86c26cbb57105fc97e4e45db2151628425675/Sources/main.swift#L689-L691)明确只让 `WKWebView` 加载该网页。 | 这是 Web Cookie 的正常浏览器登录封装，未找到生成 `i.weread.qq.com` 原生 `skey/vid` 的发送行。不能把 Web 登录成功当作移动端凭据已取得。 |
| [`JDChi/WeReadBar`](https://github.com/JDChi/WeReadBar) 及 [`Turbo1123/Turbo-IO` Objective-C 发送行](https://github.com/Turbo1123/Turbo-IO/blob/main/official-addon/focus-edition/WeReadAPI.m#L281-L334) | 用户提供 `wrk-` Key，POST 腾讯 `i.weread.qq.com/api/agent/gateway`。 | 腾讯公开 Gateway 的凭据与原生 App `skey/vid` 是不同认证入口；这些代码无两者转换。 |
| [`Cairl/WeReadIt` 的 README](https://github.com/Cairl/WeReadIt) 与 [`token_refresher.py`](https://github.com/Cairl/WeReadIt/blob/85a160a63445320ceacf3e5833d0280f5054bff7/src/wereadit/core/token_refresher.py#L37-L98) | 要求用户先用 Proxyman 捕获原生 `/login` cURL，再由 Python 重放该请求。 | 即使后续调用写成了可审查代码，最初正常登录生成来源仍是捕获的客户端请求；不满足本任务所需的无抓包来源。其 [iOS `skey`/Android `accessToken` 分支](https://github.com/Cairl/WeReadIt/blob/85a160a63445320ceacf3e5833d0280f5054bff7/src/wereadit/core/exchanger.py#L50-L75) 是**兑换**端点，不能外推 `/book/articles`。 |
| [whchen 2026-06 的一手实践记录](https://whchen.dev/notes/weread-reading-page-01) | 记录早期 iOS `vid/skey` 头的使用，说明取值方法是抓包，之后改用腾讯 Gateway。 | 佐证历史上 iOS App 确实持有相关值，不给出正常登录签发源码、有效期或当前文章端点成功结果。 |
| [腾讯公开 `WeChatReading` 仓库](https://github.com/Tencent/WeChatReading) | 提供 `wrk-` Gateway API Key 使用说明。 | 未公开 Mac/iOS 原生客户端的登录或 `skey/vid` 续期实现。 |

## 检索范围和未解决的具体问题

2026-09-30 检索 GitHub 仓库/代码及 Sourcegraph 公开代码，词组包括 `weread`、`微信读书`、`skey`、`vid`、`/login`、`i.weread.qq.com` 与 `Swift`、`Objective-C`、`Python`、`JavaScript`、`Go`、`Rust` 的组合，并追查上述 Mac 项目源码及历史。GitHub 仓库检索曾返回 Swift 9、Objective-C 2、Go 17、Rust 9 个广义 `weread` 命中；这不是认证实现计数。Sourcegraph `i.weread.qq.com` 的 Swift 查询为 0，Objective-C 命中主要是 `wrk-` Gateway，Go/Rust 结果也未给出 Mac/iOS 原生登录签发代码。[可复查的 Swift 查询](https://sourcegraph.com/search?q=context%3Aglobal%20i.weread.qq.com%20lang%3Aswift&patternType=keyword)。GitHub API 随后触发 403 限额，因此本次检索不代表完整 GitHub 索引，更不代表闭源官方客户端的实现情况。

目前**没有找到公开、可审查且无需先复制/捕获凭据的 Mac/iOS `skey/vid` 正常登录生成与续期代码**；也没有 Mac/iOS 凭据当前成功调用 `/book/articles` 的可核响应。缺口是：签发请求的真实发送行与合法输入来源、`skey` 和 `vid` 的配对及有效期、正常续期条件、文章端点的接受证据。`tanya` 的日志方式显示官方客户端可能提供一个不经网络抓包的本人合法凭据来源，但是否适于用户环境、是否可持续以及文章权限都未被证明。若以后有本人可用的官方 Mac 设备/会话或公开签发源码，可先只核这些字段与时效，再由总控依据新证据设计单次隔离验证；不应对已失败的 BOOX 样本重放 `/book/articles`。与此同时，其他腾讯文章列表候选应继续独立审查。
