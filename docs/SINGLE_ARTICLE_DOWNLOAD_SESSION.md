# 单篇下载：正常会话缺口与本地保存回归（2026-10-04）

当前直接保存功能复用 `buildArticleDownload`、`buildArticleMarkdown` 和 `LocalArticleStore`，输出下载日目录中的每篇独立文件夹、`正文.md` 和 `image/`，图片使用相对路径。默认目录仍是用户指定的 Obsidian 目录，“每次下载询问路径”默认关闭。目录由原生选择器授权并记忆，HTTP JSON 不能指定任意路径；已有笔记不覆盖。没有增加 ZIP 或人工 HTML 导入流程。

## 本次实际修复

保存询问设置时，原实现检查操作锁却没有持有锁。设置尚未落盘时，另一个标签页可以成功打开目录选择器或发起下载；下载可能读取旧的询问策略，两个设置写入也可能竞争。新增回归先在原实现复现：暂停设置写入后，选目录本应返回 409，实际返回 200。

`ArticleDownloadController.updateSettings` 现在持有原有操作锁，直到持久化成功或失败；选目录、下载和其他设置写入期间返回 409。失败通过 `finally` 释放锁，不阻止之后重新选目录。回归同时检查保存后的真实设置文件、询问策略生效、正常选择后可保存，以及写盘错误后的恢复。

验证均使用临时目录和合成文章，原生目录选择器在 HTTP 测试中被替换。相关下载、HTTP 和本地保存三套测试共 64 项通过；它们不证明用户文章下载成功，也不证明原生目录对话框真实交互通过。

完整服务器回归为 40 套、576 项通过；服务器构建配置编译和变更文件 ESLint 检查通过。运行命令：在 `apps/server` 使用 `node node_modules/jest/bin/jest.js --runInBand`、`node node_modules/typescript/bin/tsc -p tsconfig.build.json` 和 `node node_modules/eslint/bin/eslint.js src/article-download.controller.ts src/article-download.controller.spec.ts`。本地依赖只读复用既有安装，没有新增依赖。

## 正常验证后取文：已查源码

只读查公开 GitHub 代码，不安装或运行候选，也不请求用户的受挑战文章。仓库近期提交不等于特定文章实测成功。

| 候选与固定提交                                                                                                                                                                   | 真正取文实现                                                                                                                                                                                                                                                                                                                                  | 对当前缺口的作用                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Obsidian Web Clipper，6d56d61，MIT](https://github.com/obsidianmd/obsidian-clipper/tree/6d56d618b00bd970aa738d6a7a61edee27783e81)，最近推送 2026-09-22                          | [content.ts](https://github.com/obsidianmd/obsidian-clipper/blob/6d56d618b00bd970aa738d6a7a61edee27783e81/src/content.ts) 的 `getPageContent` 从当前页面 DOM 提取；[content-extractor.ts](https://github.com/obsidianmd/obsidian-clipper/blob/6d56d618b00bd970aa738d6a7a61edee27783e81/src/utils/content-extractor.ts) 向目标标签页请求内容。 | 是正常浏览器页面提取的成熟依据，不依赖复制 Cookie。仍需用户能正常读到文章、已获授权的浏览器扩展/工具及接入本地保存的传输能力；当前 WeWe 没有这个连接。没有测试它在用户文章上通过，未安装它。            |
| [weixin-article-downloader，b543530](https://github.com/huanghuang36/weixin-article-downloader/tree/b543530ef01c87cee924798fdbf13046a03a4e22)，最近推送 2026-05-05，未找到许可证 | [browser_fetcher.py](https://github.com/huanghuang36/weixin-article-downloader/blob/b543530ef01c87cee924798fdbf13046a03a4e22/tool/browser_fetcher.py) 连接用户 Chrome 的 CDP，等待用户完成验证，再调用 `page.content()`；也有独立浏览器模式。                                                                                                 | 证明浏览器模式与匿名 HTTP 的差别，但不是可以直接复用的修复：有 macOS `lsof`/启动提示，匹配标签页较宽，CDP 失败会自动再开浏览器导航。当前没有受支持的 CDP 会话，不能借它绕过工具安全停止。未复制其代码。 |
| [FavsSnap 扩展，1cd7da8](https://github.com/huanyu-a/FavsSnap_wechat-article-clip_ext/tree/1cd7da873f4b1c16d61cdd498a94aaf48d2659bf)，最近推送 2026-06-30，未找到许可证          | [sidepanel.js](https://github.com/huanyu-a/FavsSnap_wechat-article-clip_ext/blob/1cd7da873f4b1c16d61cdd498a94aaf48d2659bf/sidepanel.js) 的 `fetchArticleHtml` 仍直接 `fetch(url, {headers})`，没有读取已验证标签页正文的恢复逻辑。                                                                                                            | 安装成扩展并不证明复用了文章页面会话。不能当成这次 302 的新解法；目录保存和 Markdown 部分已由本项目实现。                                                                                               |
| [content-downloader，96723ca，MIT](https://github.com/zinan92/content-downloader/tree/96723ca46859e8db51a21b4eac779d4b5dcc6f9c)，最近推送 2026-09-27                             | 微信 [parser.py](https://github.com/zinan92/content-downloader/blob/96723ca46859e8db51a21b4eac779d4b5dcc6f9c/content_downloader/adapters/wechat_oa/parser.py) 使用匿名 `httpx.AsyncClient` 与 UA/Referer，跟随重定向；微信适配器没有浏览器恢复。                                                                                              | 项目说明中的 Playwright fallback 不能推导为微信通路有此能力。不能解决已经确认的验证重定向。                                                                                                             |

此前已查的停维 exporter 和匿名 scraping skill 不计作新进展。没有新增付费 API、采集系统、验证工具或新的平台尝试。

## 当前能做与不能宣称的事

后台 `requestDownloadResource` 无 Cookie、无重定向、无重试；本次没有改这些边界。用户在 Edge 完成官方验证不代表后台的独立 HTTP 请求获得同一权限，不能建议自动再点下载。微信读书账号正常登录也不是公众号文章页面的会话桥接。

最小合法下一步是先由用户在正常 Edge 页面确认文章正文及图片可读，再由受支持、已授权的页面读取工具检查当前标签页。若工具不能识别网址、遇验证或报告安全停止，应停止；不得用 CDP、隐藏脚本、其他入口或复制浏览器凭据继续。即使能读正文，还需明确的浏览器内容传输接口与图片字节验证才能复用现有本地保存；当前没有完成这一闭环。

可交给用户已有 Edge ChatGPT 插件的最小提示词：

> 只检查我当前已经正常打开的这篇微信公众号文章是否显示完整正文和图片。不要打开或刷新网址，不处理验证码，不读取 Cookie、浏览器存储或票据，不保存 HTML，不发送内容到其他服务。先仅返回文章标题及正文、图片是否可读；如果工具不能识别网址或报告安全停止，请原样报告并停止。

用户无需为离线代码回归操作扫码或验证。该提示只取得下一步所需的正常页面可读证据，不等于下载验收通过。

## 交接及验收边界

- 代码从已提交 `ffcc668` 建立独立 worktree/分支 `codex/single-article-session-gap`；不切换或编辑主工作区，不启动服务、不占用 4000、不部署。
- 本轮只读 SQLite 事务核验：2 个账号、12 个订阅、1450 篇文章，`quick_check` 为 `ok`。未修改数据库、生产保存设置、账号绑定、停用标记或定时刷新策略。
- 原生选目录真实交互尚未验收。本执行环境没有 `node_repl` 工具；Windows `computer-use` 指引要求所有 UI 自动化通过该工具，不得使用自制 PowerShell UI 自动化替代。没有打开悬空对话框或操作用户其他目录。
- 主线程可以在具备受支持 Windows UI 工具的环境，使用隔离配置与预先创建的临时目录，验收原生选择、取消、重新打开后的目录记忆。不要改生产设置来验证默认路径。
- 用户受挑战 URL 没有重试，真实正文、实际图片和用户目标目录中的单篇下载仍未验收。当前缺口是正常页面访问及受支持的浏览器内容通路，不能把本次操作锁修复或合成保存测试称为该缺口已解决。
- 主线程唯一负责整合和部署；取得真实正常页面证据前，不增加会话桥接安装或平台验证尝试。
