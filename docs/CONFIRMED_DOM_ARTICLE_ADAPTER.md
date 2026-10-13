# 人工确认当前文章的 DOM 适配候选

本适配复用现有正文解析、图片签名核验、一次性任务及 Markdown/image 保存器，不创建另一套导出或订阅系统。页面自己提供的 `og:url` 和静态 `msg_link` 是原文链接来源，不依赖 `rel=canonical`。两者同时存在时须按原 URL 规则一致；链接的公众号与文章身份须与静态 biz/mid/idx 一致，已有 sn 也须一致，ct/create_time 不得冲突。缺链接时不由身份拼造 canonical，不映射另一条短链。

`ConfirmedDomArticle` 是服务端内部保存的逐篇人工确认，不接收浏览器自报完整性。它固定真实原文链接、标题、公众号、发布时间和人工确认的正文图片数。浏览器只能提供与本次任务 tab/window/path/nonce 绑定的观察；实际身份、时间、正文结构、图片索引、原字节及签名仍由服务端检查。没有 review/book/目录身份被补造，单篇结果不能宣称订阅列表或覆盖。

`captureOfficialArticle({confirmedImageCount})` 只在明确逐篇确认范围内允许忽略 currentSrc/src/data-src 全部为空的图像节点。默认读取保留原规则；有来源的隐藏、延迟或额外图片仍计入，数量不符拒收。无源节点数量不等于缺失正文图片。整页或外围网络提示不能未经归属就覆盖本篇人工确认；采集器自身的候选完整性仍为 unproved。一次任务前后的正文和原图来源指纹不一致时停止，不自动重载、续期或重试。

`BrowserTaskBroker.confirmedDomArticle` 是可选的内部一篇配置，默认不存在。存在时也须原有启用、配对与来源权限门禁全部通过，只能受理这篇真实长链接的一次任务；任务失败也消耗本次授权，不自动再次采集。扩展读取只在服务器 claim 后执行，采用 ISOLATED DOM，不使用 Vue/global/store；媒体仍经过原精确 CDN 白名单、无凭据、拒绝跳转和大小限制。完成后复用原 `prepareVerifiedProviderDownload` 和本机保存器。

当前仅完成源码、合成离线读取/传输/原保存链测试。生产没有启用内部确认配置、注册回送或授予 optional 权限，已安装扩展未更换。本地测试不能称为真实文章已经保存。实际一次任务还需明确授权当前正文和确认的原图回送到本机，以及所需 localhost/CDN optional 权限与配对；授权仅覆盖本篇，不解除平台停止、不扩展为持续取文。
