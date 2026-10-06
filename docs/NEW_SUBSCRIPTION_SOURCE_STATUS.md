# 新增公众号入口的来源状态

新增弹窗原调用链为 `feeds/index.tsx → feed.addFromArticle → TrpcService.addSubscriptionFromArticle → wechat2RssProvider`。旧来源停用时，最后一步抛出 `WECHAT2RSS_DISABLED`，发生在备份、网络请求及创建订阅之前；这条错误不表示登录过期。

现在原入口先读取经过原认证保护的 `feed.addCapability`。停用来源时，弹窗明确说明新号发现及持续更新仍未接通，保留文章链接，禁止提交到旧来源。后端同样在调用旧 Provider、备份或写库之前返回有解释的前置条件失败。状态未知或读取失败也保留输入，不声称新增成功。

这项修复没有启用或购买 Wechat2RSS，也没有把当前单篇 DOM 结果冒充订阅来源。已有明确配置的来源仍保留原受理语义，任务受理不等于新文章已取得。自建新增通路仍需真实公众号发现/稳定身份/目录及原刷新合同验收，不能靠正常扫码或修改提示补足。
