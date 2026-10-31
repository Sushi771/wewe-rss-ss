# 小红书平台阅读 API 移除

小红书在平台中保留列表与外部原文链接；本地阅读通过下载或导出归档完成。本变更删除仅服务平台阅读的 `xiaohongshu.body` query 与 `XiaohongshuService.body()` 缓存投影方法，并删除仅该方法使用的 decodeInlineImage 导入。

下载、ZIP 导出、prepareLocalDownload、cache/contentHtml、图片与视频生成及校验、原生保存器、互动/评论/指标接口全部保留。没有数据库迁移、数据清除或用户文件操作。

## 调用者与整合边界

基线前端阅读页通过 `trpc.xiaohongshu.body.useQuery` 获取正文，XhsEngagement 三处 body.invalidate 用于刷新该阅读缓存。Sites 本地契约脚本亦调用 `caller.xiaohongshu.body`。本候选同时删除 Sites 的小红书 body 分支，并在解析阶段拒绝小红书 body 与依赖旧 body 的浏览器 HTML download 命令，保证不会进入调用者或传输层。公众号缓存阅读及浏览器下载安全检查继续保留；小红书原生本地下载接口保留。前端调用由对应候选删除，后端不会为兼容旧平台阅读代码重新添加接口。

旧服务测试的正文/图片断言改为检查相同持久缓存，保留原去重、完整 ZIP、相对媒体路径、实际图片哈希、网络禁用和旧数据不变断言。新增运行时检查：旧 body 路由返回 NOT_FOUND，服务原型不存在 body，且旧路由调用不会读取缓存正文。

## 精确回归边界

`xhs-reader-removal.json` 只记录已删除的固定路由、服务方法与导入。测试首先断言它们在现代码中不存在，再仅为兼容性校验暂时恢复该删除片段。原 wholeCreator/engagement/非小红书 router pins 均保持原值。完整服务与路由还原后的哈希必须匹配公开基线，证明归档及其余代码没有顺带变化。

反例检查要求：重新引入 body 路由/服务方法必须失败；更改归档 complete 门槛也不能通过删除片段的回填掩盖。此类回填只在离线测试内存中执行，不生成生产 API。

验证使用合成 SQLite、图片、ZIP 和本地保存目录，不访问真实平台。代码候选不等于部署验收；最终应与删除前端调用的候选整合后统一检查前后端类型和交互。

## 视频回归断言校准

新纳入检查的 subscription-video 测试在公开基线也有一条既存失败：它把“预算前不读视频 BLOB”写成了“预算前完全不调用 findFirst”，而现有实现会明确选择 metadata 与 contentHtml 计算预算。本候选只校准这条测试，未改变归档实现或 25,000,000 字节门槛。

测试继续要求超预算返回 PRECONDITION_FAILED，且所有预读必须具有显式 select 并排除 videoBytes；没有 select 的整行读取视为违规。另检查超预算前未创建临时目录、未写本地文件、未调用本地准备器或 ZIP 打包器。恢复合法元数据后的真实视频/封面 ZIP 哈希和相对 Markdown 路径断言继续执行。
