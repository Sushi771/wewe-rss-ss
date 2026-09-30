# 搜狗移动文章卡到公众号主页的静态链（2026-09-30）

## 本轮范围

继续[账号字段桥接审计](SOGOU_GZHJS_OPENID_BRIDGE.md)，只读已保存的目标号名移动首屏（仓库外 HTML SHA-256 `169880e6c825d70cc7c0258150414426265af5d0eaab745055ceee1152dbd13b`）、同页内联模板、已缓存的七份第一方 JS 和 [`next_page.min.js?v=20200326`](https://weixin.sogou.com/new/wap/js/next_page.min.js?v=20200326)。另查开源发送代码及近期 commit/issue。**本轮没有请求目标搜索、`/gzh`、`/gzhjs`、账号主页或微信原文。**不公开目标名称、`openid`、标题、卡片 href 或账号主页 URL。

## 当前第一方页面实际给出的桥

| 材料 | 代码或 DOM 事实 | 可用边界 |
| --- | --- | --- |
| 已保存的 `type=2` 搜索 HTML | 9 张文章卡的 `span.s2[data-openid]` 为 8+1 分组；八张目标号同名卡共用一个值。当前文章卡与其 `#article_tpl` 用的是文章 `encArticleUrl`，**没有** `encGzhUrl` 锚点；DOM 中账号卡 `.gzh-box` 为 0，带 `openid` 的账号 href 为 0。 | 可从当前结果正常读取账号分组标识，**不能从这八张文章卡直接点击账号主页**。 |
| **同一份当前 HTML** 的 `#account_tpl` | 账号卡 `<li d="${accountItem.openid}">` 内的账号 `<a href="${accountItem.encGzhUrl}">` 是页面给出的主页链接；另有一条可选 `encArticleUrl` 最新文章链接。模板本身有字段占位符，当前 `type=2` DOM 没有实例化账号卡。 | 只要正常账号搜索返回一张卡，便可把卡片 `d` 与已存 `data-openid` **逐字比较**，并读取页面实际提供的主页 href，无须拼或解密 URL；尚未拿到当前目标账号卡或真实 href。 |
| 同页引用的[第一方续页 JS](https://weixin.sogou.com/new/wap/js/next_page.min.js?v=20200326) | 解析 `items[]` XML 的 `<openid>`（缺时回退 `<id>`）及 `<encGzhUrl>`；仅当 `window.uigs_para.weixintype == "1"` 时把结果送给 `#account_tpl`，否则送给 `#article_tpl`。点击 `#next_page` 会按当前 URL 加 `page=N&_rtype=json`，但该函数只说明页 2 的拼法。 | 第一方代码证实**账号搜索结果模板期望这些字段**；不能推出 type=1 当前第一页成功、目标匹配、分页成功或账号主页内容。不得从这段续页代码猜出另一个 `/gzhjs` 请求。 |
| [第一方 `event.min.js?v=20200407`](https://weixin.sogou.com/new/wap/js/event.min.js?v=20200407) | `.gzh-box` 点击处理器读其 `<a>` 的 href，放入中转页的 `<a>`；这才是账号结果的正常点击链。文章结果的 `data-openid` 另用于分享浮层。 | 中转页不是当前文章首屏上的可点击账号入口；账号 href 的实际域名与路径只有真实账号卡回包才能确认。该脚本不请求 `/gzhjs`。 |

因此出现了比“拿当前 `data-openid` 直接试旧 `/gzhjs`”证据更强的**另一条候选**：正常账号搜索 → 从真实账号卡取 `openid` 和 `encGzhUrl` → 与已存文章卡 `openid` 核对 → 再审官方主页。这不是现成的订阅列表；只是能否合法发现目标账号主页的下一验证问题。

## 开源历史代码与近期证据

- [`Chyroc/WechatSogou` 固定当前 HEAD `6a7e08c`](https://github.com/Chyroc/WechatSogou/tree/6a7e08caa82dd7cf47331d7c303f578a4b325360) 中，[`request.py` 89–112 行](https://github.com/Chyroc/WechatSogou/blob/6a7e08caa82dd7cf47331d7c303f578a4b325360/wechatsogou/request.py#L89-L112)生成旧**桌面 HTTP** `/weixin?type=1&page=N&ie=utf8&query=...`；[`api.py` 285–296 行](https://github.com/Chyroc/WechatSogou/blob/6a7e08caa82dd7cf47331d7c303f578a4b325360/wechatsogou/api.py#L285-L296)真 GET 并解析账号搜索结果；[`structuring.py` 72–95 行](https://github.com/Chyroc/WechatSogou/blob/6a7e08caa82dd7cf47331d7c303f578a4b325360/wechatsogou/structuring.py#L72-L95)从账号卡解析 `open_id/profile_url`，而[同文件 407–437 行](https://github.com/Chyroc/WechatSogou/blob/6a7e08caa82dd7cf47331d7c303f578a4b325360/wechatsogou/structuring.py#L407-L437)从移动文章结果的 `span/@data-openid` 取 `open_id`。这是同一个可审项目对两类搜狗卡片字段的语义映射，却不是本页的近期成功回包。
- 该项目 [`api.py` 435–448 行](https://github.com/Chyroc/WechatSogou/blob/6a7e08caa82dd7cf47331d7c303f578a4b325360/wechatsogou/api.py#L435-L448)用账号搜索给出的 `profile_url` 再 GET 微信主页，解析最近群发；[README 的旧示例及 FAQ](https://github.com/Chyroc/WechatSogou#问题集锦)说主页是最近十条、临时签名 URL 可过期。其 HEAD 的 2026-03-07 提交只是删除 README 支付二维码图片；**提交日期不等于取文代码在 2026 成功**。2019 年[维护 issue #235](https://github.com/Chyroc/WechatSogou/issues/235)已报告额外 `/link?url=` 层，说明旧 URL 形状曾变过。
- [旧移动 JSONP 代码转载](https://blog.51cto.com/u_16213650/11760069)确有 `http://weixin.sogou.com/weixinwap?_rtype=json&ie=utf8`、`type:1` 账号搜索与 `encGzhUrl` 保存；转载日期是 2024 年，原设计是 Vue 2 时代的旧代码，不能当作当年更不当作 2026 年的成功回包。本轮检索 2025–2026 GitHub、issue 和公开网页的 `gzhjs`、`encGzhUrl`、`weixinwap type=1`、`data-openid` 组合，未找到当前 HTTPS 账号页或 `/gzhjs` **实际发送且成功返回目标格式**的一手记录。此阴性结论仅限所查来源。

## 下一次最小验证的精确门禁

`type=1` **账号发现**与已测 `type=2` 文章搜索、匿名页 2、桌面 `/link`、历史 `/gzhjs` 是不同请求条件；现行 HTML 仍附账号模板和第一方渲染分支，可单独评估一次低频 HTTPS 账号搜索。候选第一页为 `GET https://weixin.sogou.com/weixinwap?type=1&query=<已知目标号名>`，参数由旧源码的账号搜索类型与当前移动页入口推导，**不是已经观察到的 2026 首屏发送行**。请求前从已保存 HTML 私有读取目标文章卡共有 `data-openid`，设持久单次哨兵；一次 GET，8 秒超时、128 KiB 上限、不跟跳转、不重试、不访问 `/approve`。遇 403、429、验证码、异常跳转或非 HTML 立即停。

只在账号结果卡的**显示名与私有目标号名精确匹配，并且卡片 `openid` 与上述 `data-openid` 逐字相同**时读取页面给出的 `encGzhUrl` 锚点；仅记录域名、路径类别、是否是完整 HTTPS 腾讯 URL，不公开完整 href，也**不在本次请求中访问它**。无匹配、多个同值或 HTML 缺字段都按实际返回形态停；不能用旧书签的 `/gzh?openid=` 模板、历史微信签名 `profile_url` 或账号 ID 自拼主页。若有唯一匹配，再另审主页链接的访问、Cookie、十条上限、原文 `biz/mid/idx/sn/ct`、正文和图片。当前没有 `/gzhjs` 的第一方发送链或近期成功 JSONP，它仍是独立的历史假设，不能与这次账号搜索合并请求。
