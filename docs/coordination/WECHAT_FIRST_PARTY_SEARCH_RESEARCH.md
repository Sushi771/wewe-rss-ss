# 微信原生搜一搜的 Web／移动取文入口：独立核查（2026-09-30）

## 范围与判据

本轮只核查腾讯原生“微信搜一搜”的公众号**文章搜索**。已另案研究的微信读书搜索、搜狗微信搜索、公开合集及公众号主页不在此轮重复验证。候选须给出可审查的真正 HTTP 发送行、腾讯域名、正常认证来源和续期、文章结果与续页字段；只有页面跳转 URL、原生桥相对路径或私有数据商 API，均不足以设计自建后台探针。本轮仅下载公开静态代码、阅读公开仓库及接口说明；没有请求目标号、搜索业务接口，也没有使用私人凭据。

## 第一方页面实际代码

2026-09-30 读取不含查询词的 [`https://search.weixin.qq.com/`](https://search.weixin.qq.com/)：HTML 标题为“微信搜一搜”，固定加载腾讯静态 [`index.813093e8.js`](https://search.wxqcloud.qq.com/t/serviceSearchWeb/website/25010101/js/index.813093e8.js)（SHA-256 `473B8C6E396856062FF9530C758190FAFAE691424402507F3EE8C406F7010A1B`）和 [`chunk-vendors.c152a1df.js`](https://search.wxqcloud.qq.com/t/serviceSearchWeb/website/25010101/js/chunk-vendors.c152a1df.js)（SHA-256 `BDC6F4016A19C76178DC85F04EA78A28E842D0C34B731F87F86F8D8938CB3BEC`）。路径 `25010101` 是静态发布路径，不能当作本轮新增接口的日期证据。

业务 bundle 单行字符偏移约 `21067–22500` 给出真实发送行：`proxyReqUrl` 在生产环境返回 `https://wsad.weixin.qq.com`，`getNewsList` 与 `getNews` 用 `p.a.get` 请求 `/cgi-bin/servicesearchweb/latestnews`。续页传 `last_item_idx`、`last_msgid`，读回 `news_list`。页面把该区明确标为“最新动态”，相邻代码还以 `readtemplate?path=page/search/latest_news` 加载该栏目；它是**搜一搜开放平台公告列表**，不是公众号文章列表。该 bundle 里的 `openMPWeb` 仅 `window.open("https://mp.weixin.qq.com")`，未将 `biz`、账号名或文章条件发送到腾讯搜索服务。`getjsapiticket`（偏移约 `18206`）用于页面分享 JS SDK，不能当作文章搜索认证。上述结论只覆盖根页面当时返回的这两份固定 JS，不排除腾讯另有微信客户端内部页面。

2024 年公开的 [`christmas_jump` 链接实例](https://www.v2ex.com/t/1005822)与 [微信读书搜索的 Web 跳转源码](https://github.com/KANIKIG/wechat-search-weread/blob/ce5c78ebf71ad751c0035cac076dc87e9cb95c2b/scripts/search_weread.py#L155)说明 `newsearchweb/userclientjump` 是页面**导航入口**。前者要求在微信内打开，后者固定进入 `page/search/weread`；均没有提供原生微信“文章”栏目的 HTTP 请求、登录签发或续期代码。不能从导航 `path` 猜造文章搜索 endpoint。

## 2025–2026 开源实现与闭源中转边界

| 实现与固定源码 | 真正数据来源及边界 | 对账号级订阅的证据 |
| --- | --- | --- |
| [tony-eya/wechat-soss-scraper `9c2aa25` README](https://github.com/tony-eya/wechat-soss-scraper/blob/9c2aa257e714354da702558ed2a60435de7dc5ca/README.md#L15-L51)、[TagUI 流程](https://github.com/tony-eya/wechat-soss-scraper/blob/9c2aa257e714354da702558ed2a60435de7dc5ca/tagui/flows/wx/article/tag_all.tag#L1-L65)；仓库 2026-08-05 更新 | 桌面微信窗口中点击“搜一搜”与“文章”，OCR 解析滚动列表、逐篇点开并复制链接。没有向腾讯域名发送文章搜索 HTTP 的代码；这条采集流程触及本项目明确禁止的 PC 微信窗口与剪贴板。 | README 声称可按号、按日期收集原生 UI 可见文章，但未证明可用的自建后台请求、稳定发表时间、原文 `ct` 或长期续页。不能转为 Provider 或 Probe。 |
| [fancyboi999/weixin_search_mcp `a5a70a2` 发送行](https://github.com/fancyboi999/weixin_search_mcp/blob/a5a70a26ca36dc7ebb201ce9d9bb54a746758ecb/weixin_search_mcp/tools/weixin_search.py#L19-L84)；仓库 2026-08-17 更新 | `requests.get("https://weixin.sogou.com/weixin", ...)`；`type=2` 搜文章。确有可审查 HTTP，但属于已另案研究的**搜狗**，不是原生微信搜一搜。 | 有关键词及页码，不能据此推出微信原生搜索登录、按 `biz` 过滤或完整号史。 |
| [wbsu2003/weixin-search-mcp `2dc3128` 调用行](https://github.com/wbsu2003/weixin-search-mcp/blob/2dc312854cd914f63135673d93387de46402a51d/main.py#L1-L44)、[维护者说明](https://laosu.tech/2025/06/27/%E5%BE%AE%E4%BF%A1%E5%85%AC%E4%BC%97%E5%8F%B7%E6%96%87%E7%AB%A0%E6%90%9C%E7%B4%A2MCP%E6%9C%8D%E5%8A%A1weixin_search_mcp/) | `/search_articles` 只调用依赖包 `miku_ai.get_wexin_article`；维护者明确说该库基于搜狗引擎。仓库不含腾讯原生搜一搜 HTTP 发送行。 | MCP 服务外壳及博客 2026-09 更新不等于新的文章来源。 |
| [um-why/wechat-search-skill `721d95a` 任务代码](https://github.com/um-why/wechat-search-skill/blob/721d95aedda0c5ef41d836d30f76d962b21a72f0/scripts/api/article.js#L17-L67)、[HTTP 发送行](https://github.com/um-why/wechat-search-skill/blob/721d95aedda0c5ef41d836d30f76d962b21a72f0/scripts/utils/request.js#L8-L11)、[主机常量](https://github.com/um-why/wechat-search-skill/blob/721d95aedda0c5ef41d836d30f76d962b21a72f0/scripts/config/constants.js#L1-L15)；仓库 2026-06-23 更新 | 请求 `/api/wechat/article-search/*`，实际 HTTPS 主机是 `www.guaikei.com`，使用该服务 token。开源代码只到私人服务入口，没有腾讯上游发送行。 | 参数有 `sort`、`publish_time`、`limit`，但这些是闭源中转的契约，不能当腾讯接口参数或正常微信登录来源。 |
| [极致了 API 文章搜索文档](https://apifox.com/apidoc/shared/410674f9-f451-4b4f-957a-5f54f243bc83/api-264402406)、[Wellbyte 文章搜索文档](https://www.wellbyte.net/en/docs/api/wechat_mp-search-article_v1) | 前者明示发送至 `www.dajiala.com/fbmain/monitor/v3/web_search` 并需商家 `key`；后者发送至 `api.wellbyte.net/v1/wechat_mp/search/article_v1` 并按积分计费。文档展示 `BusinessType=2`、`cookies_buffer`、`offset` 等字段，Wellbyte 自报 2026-09-23 样例有 `continueFlag=1`。两者均未公开实际腾讯请求与认证链。 | 只能说明供应商声称提供实时搜索及续页；其转述的参数、样例与更新时间不能直接转为可自行部署的腾讯来源，也没有目标 `biz` 精确过滤或原文 `ct` 的一手证明。 |

## 本轮判定与再开启条件

固定根页面的唯一可复核分页请求是开放平台公告 `/cgi-bin/servicesearchweb/latestnews`；近期原生文章搜索开源项目走被禁止的桌面 UI；具有 `BusinessType`、`cookies_buffer` 的公开接口则停在第三方闭源中转。本轮未找到**不同于微信读书搜索和搜狗**、同时具有腾讯文章搜索 HTTP 发送行与合法可续期认证的 Web／移动实现，因此没有可交给独立 Probe 的新请求。此判断**仅排除上述具体页面、仓库和供应商路线**，不表示腾讯原生搜一搜没有文章索引或自建订阅整体不可行。

若后续发现腾讯第一方文章搜索页面的固定静态 JS，或开源客户端能展示其对腾讯域名的实际发送行、正常登录签发与续期，并说明账号过滤、续页和原文 URL／`ct`，再复审是否设计一次低频隔离请求。若证据仅为 `_tencent_jsbridge.postCGI({path: ...})` 一类原生桥相对路径，须先找到合法宿主把它映射为真实腾讯 HTTP 请求的公开实现；不能猜主机、搬用微信读书 Cookie 或重放未证实参数。
