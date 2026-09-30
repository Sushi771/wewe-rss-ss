# 搜狗移动账号搜索首屏：单次只读 Probe 离线准备

2026-09-30。只实现并离线自测 [`probe-sogou-mobile-account-one-shot.cjs`](../../scripts/research/probe-sogou-mobile-account-one-shot.cjs)；**本轮真实网络请求 0、生产 SQLite 写入 0**。线上执行须由总控复核当前第一方发送链和脚本后另行决定。

## 请求依据和独立性

B 线固定的[当前移动页静态审计](SOGOU_ACCOUNT_PAGE_CHAIN.md)指出，既存 `type=2` 文章搜索 HTML 中 `#account_tpl` 使用 `accountItem.openid` 与 `accountItem.encGzhUrl` 渲染账号卡；页面所引[第一方 `next_page.min.js`](https://weixin.sogou.com/new/wap/js/next_page.min.js?v=20200326)仅在 `weixintype == "1"` 时选择账号模板。当前保存的文章卡则是 `type=2`，没有可点击的账号主页锚点。旧开源账号搜索代码给出 `type=1` 的语义，但这里的 `GET https://weixin.sogou.com/weixinwap?type=1&query=<既有精确号名>` 仍是**待验证的当前移动首屏请求形状**，不能写成已观察到的 2026 年发送行。

本次只问：正常匿名账号搜索第一页是否返回账号卡；若有精确显示名卡，卡片 `openid` 是否与既存文章搜索卡的账号标识一致；页面给出的 `encGzhUrl` 是什么**主机和路径类别**。本探针不访问账号主页、`/gzhjs`、`/link`、文章或下一页，也不尝试验证码。

## 种子、门禁和输出

脚本先只读已保存于用户私有目录的 `type=2` 首屏，要求整份 HTML 的 SHA-256 与既有审计固定值相同；从九张文章卡中取得唯一一组八张同名卡，要求八张 `data-openid` 逐字一致。再以 `DatabaseSync(..., { readOnly: true })`、`PRAGMA query_only=ON` 和 `quick_check=ok` 确认此显示名在生产 `feeds` 中唯一。查询词来自这条私有证据链，不从命令行接收名称，也不输出名称或 `openid`。当前离线预检结果：**九张卡、其中八张同名且账号标识一致、数据库名称唯一、目标哨兵不存在**。

线上模式需要 `--execute --approved-online` 两个显式开关，并在任何请求前以独占创建、同步落盘的方式设置固定私有 `attempt.json`；存在时禁止重试，切换模式也不能重试。只有一次原生 HTTPS GET；无请求 Cookie、认证、代理、自动跳转或重试，8 秒超时、128 KiB 响应上限，只接受 HTML。403、429、验证码、异常跳转、非 HTML 或超限都停止。完整响应 HTML、请求 URL、既存 `openid` 和匹配账号卡的原始 href 只写用户主目录私有文件，不进入 Git；控制台只给 HTTP/挑战状态、账号卡数、精确名称卡数、账号标识是否匹配，以及匹配卡的 `encGzhUrl` 主机/路径类别。页面 href **只解析形状，不发送第二次请求**。

解析器按当前 `#account_tpl` 的结构选择 `li[d] .gzh-box`，从 `.gzh-tit` 读显示名、`li[d]` 读账号标识、`.gzh-box > a[href]` 读页面给出的主页链接。只有一张卡同时满足名称和标识一致，才输出 href 类别；多张则报歧义。该判断仍只是搜狗索引账号一致性，不能替代腾讯官方 `__biz`、原文 `ct` 或真实订阅验收。

## 已执行的离线验证

- `node --check` 通过。
- `--plan` 显示单请求、超时和大小上限，网络请求 0。
- `--preflight` 确认上述私有来源及只读数据库门禁通过，网络请求 0。
- `--self-test` 用六组假响应验证：唯一匹配、同名但账号标识不同、HTML 验证码、验证跳转、非 HTML、响应超限；每组再次执行均在哨兵处拒绝，真实网络请求 0。

未执行 `--execute`，用户私有目标哨兵未创建。即使后续首屏得到账号主页链接，也必须另审该主页当前页面能力、会话限制和文章身份；这次账号发现结果本身不等于跨号文章列表或五篇真实目标文章。
