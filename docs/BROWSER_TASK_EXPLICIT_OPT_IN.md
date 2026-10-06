# 单篇浏览器任务显式启用候选

0.2.1 补齐固定本机端口、扩展权限确认/撤销和应用路由接线。默认关闭；本轮未安装、授权、配对或部署候选，已安装只读扩展与运行服务保持原样。离线合成正文和 PNG 保存不能称为实站恢复。公众号目录、任意新公众号发现与持续新文刷新仍需分别验收。

## 单篇权限与确认

popup 启动仅显示浏览器提供的当前标签页标题，不请求权限、领取任务、读取正文或通信。填写原 WeWe 创建的任务配置、勾选权限说明并点击授权后，才调用 `chrome.permissions.request`；拒绝后不能领取任务或读文。仅申请 optional `http://127.0.0.1/*` 和 `https://mmbiz.qpic.cn/*`。Chrome 匹配语法不限制端口，客户端原始字符串、服务端配置与 Host 都固定 `http://127.0.0.1:4000`；其他端口、localhost、地址缩写与重定向拒绝。

领取仅传关联信息，服务器披露固定文章的标题、公众号、真实原链接、发布时间、已确认图片数与原下载工具当前保存目录，显示为纯文本。另行勾选正文回送并提交后才采集。页面静态身份、链接、标题、来源与时间须先和任务一致，再复制净化正文/原图；完成前再次检查同一 tab/window/path、正文与资源指纹。用户已确认的单篇使用 ISOLATED DOM，无需 Vue。

图片仅获取已加载的精确 CDN URL，省略凭据、拒绝重定向、十秒超时，无重试；不读 Cookie/token/ticket、存储或整页面状态。任务五分钟有效，拒绝重复。确认后原目录改变返回 `SAVE_DIRECTORY_CHANGED`，保留已接收正文，取消旧任务并重新确认，不能悄悄改存别处。

取消阻止后续读取/发送并 Abort 网络传输；已执行的注入不能撤回，其返回后再次核取消标志。关闭 popup 不等于取消。服务器可能在取消前已接收正文，须到原 WeWe 核对并取消尚未保存任务，已保存文件不自动删除。撤销按钮移除两项 optional 权限；尚未结束的授权弹窗若迟到批准，会再次撤销。关闭弹窗后以扩展设置实际权限为准。

`accepted:true` 仅表示已接收并核验。写盘由原 WeWe 保存按钮、当前登录认证、Origin、目录授权与原保存器执行；扩展不显示“保存成功”、不写数据库、不改旧笔记或后台停止记录。

## 服务端显式授权

实际用户批准本次本机/图片权限与单篇正文回送后，operator 才可创建私有批准文件。必须同时设置 `WEWE_BROWSER_TASK_OPT_IN=1` 与绝对路径 `WEWE_BROWSER_TASK_OPT_IN_FILE`；未设置开关时返回原 AppModule，不注册接收 controller，不创建配对或消费文件。设置开关而文件缺失/非法时拒绝启动，私人线上模式也拒绝启用。

文件最多 16KiB，普通文件、非符号链接。精确字段如下，placeholder 不是有效配置：

```json
{
  "version": 1,
  "approved": true,
  "approvedAt": "用户授权时的ISO时间",
  "expiresAt": "授权后至多十五分钟的ISO时间",
  "localOrigin": "http://127.0.0.1:4000",
  "extensionOrigin": "chrome-extension://实际32位扩展ID",
  "pairingKey": "私下生成的32字节base64url密钥",
  "article": {
    "originalUrl": "页面实际给出的微信文章/s长链接",
    "title": "用户确认的标题",
    "publisher": "用户确认的公众号",
    "publishTime": 1700000000,
    "imageCount": 1,
    "confirmedComplete": true
  }
}
```

私有权限保存，不提交文件/密钥，不要求用户把秘密发到聊天。批准最长十五分钟，任务最长五分钟且不能超过批准截止。签发前以原子 `wx` 写同路径 `.consumed` 标记；消费或过期后重启默认关闭，并发实例不能重放。不自动清标记、续期或重签；新授权需用户重新明确批准。

动态 opt-in 根向原下载和传输 controller 提供同一个 BrowserTaskBroker。仅启用时关闭 Nest 自动 parser，在原全局 10MiB parser 和通用 CORS 之前挂 `/browser-task`，原 privateAccessGuard 在更前。复用已有精确 preflight、loopback/Host/Origin/配对鉴权与 scoped parser，未配对非法 JSON 在解析前拒绝；complete 上限 35,000,000 字节，claim/cancel 4KiB，其他接口仍 10MiB。没有新采集框架或公开签发 API。

## 验证与剩余验收

真实 Nest 根模块的离线测试覆盖默认路由缺失、共享 broker、严格 preflight、解析前鉴权、有效 PNG 的大于 10MiB JSON、其他路由大小限制、目录披露/变更、接收与保存分离、原 Markdown/PNG 保存、重复与旧笔记保护、取消及跨重启一次消费。扩展回归执行真实序列化采集函数和 popup 事件，覆盖拒绝、过期、重复、读取/图片中取消、迟到授权撤销、迟到 ACK 与纯文本说明。平台依赖、权限和浏览器传输均为离线 fixture，无真实平台/CDN 请求。

```powershell
pnpm --filter server exec jest browser-task browser-article article-download.controller --runInBand
node --test extensions/wewe-official-task/*.test.mjs
pnpm --filter server build
pnpm --filter web build
```

用户醒来后先审查功能包与授权范围，明确批准安装候选、本次权限和单篇回送，再进行一次真实接收、原按钮保存和 Markdown/图片打开验收；未通过不得记为恢复。已安装只读包保持原样。
