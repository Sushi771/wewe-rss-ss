# 单篇阅读与点赞来源独立核查（2026-09-27）

结论：**南模篇公开正文和身份已确认；真实阅读、点赞尚未取得，收藏没有可信来源。** 本轮没有写生产库，没有将空字段写成 0，没有开启热度排序，也没有把公众号后台扫码权限当成他号私有统计权限。

## 固定目标及本机证据

- 文章：<https://mp.weixin.qq.com/s/K_oKauPpwhSyavBWQXFMKw>
- 身份：`biz=Mzg5NTQzMTQxMg== / mid=2247493540 / idx=1`。
- 探针：`scripts/probe-article-metrics.cjs`。默认仅请求该公开文章一次；`--authorized-web-cache` 必须在本人授权受限 HTTP 缓存读取后使用。
- 证据目录：Git 忽略的 `output/playwright/article-metrics/`。仅保存脱敏探测摘要、公开开源代码和提交记录；不保存微信 Cookie、会话值或授权原始 HTML。

北京时间 **13:32:29** 公开页实测 HTTP 200、3,480,633 字节，有 `js_content`，三元身份精确一致，无验证页标记。响应 SHA-256 为 `a6e1cc9439038afbe66f02c40e1b54d5cf7a46bd61069baa4f768e0b3ba6ebe1`。`read_num_new`、`read_num`、`old_like_count`、`like_count`、`like_num`、`share_count` 的已匹配赋值都是空字符串；没有取得 `favorite_count`。页面包含 `getappmsgext` 引用，但没有可用的 `appmsgstat` 响应。**正文可读不等于互动指标可读。**

本人随后确认已在电脑微信打开该篇。**13:34:00** 只在既有授权范围内检查 `%APPDATA%/Tencent/xwechat/radium/web/profiles` 下最近 30 分钟的 `Cache/Cache_Data` 文件：154 个目录、13 个文件、38,472,920 字节，未触及预算，没有该篇同时含 `uin/key/pass_ticket` 的文章请求候选。**13:34:45** 在同一范围增加只输出 URL 形状的诊断，兼容 `http/https` 和无参数短链：仍为 154 个目录、13 个文件、32,939,266 字节，没有目标 URL 形状或会话候选。缓存会变化，两次字节数不同；不能据此判断本人是否打开成功。

两次缓存探测均未发送授权上游请求，未复用先前 `profile_ext home` 会话，没有重试 `home/getmsg`。读取边界排除了 Cookies、History、Login Data、聊天数据库、Local/Session Storage、IndexedDB、附件、图片、日志和程序文件。没有修改系统代理、证书或 Defender。

真实指标验证停在“没有取得该篇可用会话请求”，不是服务启动问题，也不证明所有微信指标接口永久不可用。没有该篇真实授权响应，第二篇与刷新验收不能开始。

## 审查的候选实现

| 候选                                   | 固定提交 / 许可文件                                                                                                                              | 入口及真实上游                                                                                                                                | 会话、依赖和实际判断                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hjyl-cheng/wechat-pcspider             | `930c4a39331eb657cd7059615f39bac5bc6d7dcc`（2026-01-16）；LICENSE 为 Apache-2.0，README 又写仅学习研究、勿商业使用，二者存在表述冲突，未移植源码 | `ArticlesInfo.read_like_nums → __get_appmsgext` POST `https://mp.weixin.qq.com/mp/getappmsgext`；`get_article_stats_from_url` GET 第一方 `/s` | 前者需要文章会话 `appmsg_token` 和 Cookie；后者使用文章页 `uin/key/pass_ticket`。原捕获流程使用 mitmproxy、PC 微信及证书，并将凭据写文件；本轮仅审查，未安装运行。普通文章与部分视频分支可见；不足以证明贴图/转载/转发覆盖。                    |
| wechat-article/wechat-article-exporter | `a7bffa6e481a188510a701d30b399b76573434e5`（2026-08-07）；MIT，Copyright 2024 Jock                                                               | `ExtractSetCookie.response` 观察 `https://mp.weixin.qq.com/s?__biz=`；`profile_ext_getmsg.get.ts` GET 第一方 `/mp/profile_ext?action=getmsg`  | 插件经 mitmproxy 捕获文章 URL/Set-Cookie，写 `credentials.json` 并在 `*:8088` 提供服务。类型声明含 `uin/key/pass_ticket/wap_sid2/appmsg_token/cookie`。其 getmsg 与已失败路线没有可证明的新差异，未重跑。此插件没有提供当前目标号指标成功证据。 |

可定位源码：

- [ArticlesInfo.py](https://github.com/hjyl-cheng/wechat-pcspider/blob/930c4a39331eb657cd7059615f39bac5bc6d7dcc/wechatarticles/ArticlesInfo.py)
- [extract_stats_from_html.py](https://github.com/hjyl-cheng/wechat-pcspider/blob/930c4a39331eb657cd7059615f39bac5bc6d7dcc/extract_stats_from_html.py)
- [download_full_html.py](https://github.com/hjyl-cheng/wechat-pcspider/blob/930c4a39331eb657cd7059615f39bac5bc6d7dcc/download_full_html.py)
- [capture_new_wechat.py](https://github.com/hjyl-cheng/wechat-pcspider/blob/930c4a39331eb657cd7059615f39bac5bc6d7dcc/capture_new_wechat.py)
- [remove_favorite_count.py](https://github.com/hjyl-cheng/wechat-pcspider/blob/930c4a39331eb657cd7059615f39bac5bc6d7dcc/remove_favorite_count.py)
- [exporter Credential 插件](https://github.com/wechat-article/wechat-article-exporter/blob/a7bffa6e481a188510a701d30b399b76573434e5/public/plugins/credential.py)
- [exporter Credential 类型](https://github.com/wechat-article/wechat-article-exporter/blob/a7bffa6e481a188510a701d30b399b76573434e5/types/credential.d.ts)
- [exporter getmsg](https://github.com/wechat-article/wechat-article-exporter/blob/a7bffa6e481a188510a701d30b399b76573434e5/server/api/web/mp/profile_ext_getmsg.get.ts)

## 字段语义与拒绝移植的行为

| 原字段                                                  | 候选源码中的称呼                                      | 当前可采信程度                                                 |
| ------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `appmsgstat.read_num` / HTML `read_num_new`、`read_num` | 阅读                                                  | 本篇公开页为空；未取得授权响应，尚未核实值和计数上限           |
| `old_like_num` / `old_like_count`                       | 旧赞 / 拇指赞                                         | 需要真实响应与当前微信 UI 对照，不能只凭字段名接到正式点赞排序 |
| `like_num` / `like_count`                               | 源码不同位置混称点赞、喜欢、收藏                      | 与拇指赞不能自动等同；在看/喜欢语义仍待当前响应与 UI 验证      |
| `favorite_count`                                        | README 示例与 `like_count` 同值，另有删除重复字段脚本 | 不能证明收藏总数；保持 null / unavailable                      |

`extract_stats_from_html.py` 把空字段及解析异常归零，且即使未取得指标也可能返回 `success=True`。其中 `like_count: '(.*?)'` 未限定字段边界，会匹配 `old_like_count` 后半段。这些行为不符合缺失保留和语义要求，未用于项目采集。新探针明确限定字段边界，并保留 `empty`、`numeric_unverified`、`non_numeric_redacted` 三种观察状态。

公开源码只提供待验证协议假设，不能代替真实采集验收。当前没有向生产服务加入未经验证的指标适配器或伪授权入口。后台扫码后的列表权限、文章页微信会话、自己公众号的官方统计权限应独立验证。

## 真正尚缺的证据与停止边界

下一步需要取得该篇**实际文章请求及对应响应**，同时能精确核对 `biz/mid/idx` 和观测时刻。现有受限缓存没有提供它；继续重复打开相同页面和扫相同缓存没有新依据。

若另选直接网络捕获或原生客户端调试，必须先审查并说明具体读取对象、持久化策略、所需证书/代理/客户端常驻成本，再由本人决定；本轮没有扩大到进程内存、原生注入、Cookie 数据库、全盘搜索或全局代理。MITM 候选触及目前明确禁止的全局代理/证书边界，不能自动启用。

只有真实指标响应与界面语义均通过后，才可以实现 `source/fetchedAt/rawField/value-or-lower-bound/missingReason` 存储、失效处理和刷新；失败不得抹掉历史有效值。收藏仍须独立可信原字段，不能从点赞、喜欢、个人收藏状态或截图推算。

本轮验证命令：`node --check scripts/probe-article-metrics.cjs`；公开探测一次和受限缓存探测两次。探测没有调用写库、迁移或下载器，也未安装新依赖。以上只证明当前来源的验证结果，不证明完整公众号列表恢复。
