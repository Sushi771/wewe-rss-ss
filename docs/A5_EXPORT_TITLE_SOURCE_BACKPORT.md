# a5 导出标题与原文链接修复回移

本分支直接基于 `a5e8f2544f7836df503794d684f5b607cccc071e`，按函数回移 PR67 `fcc71f6f0b6c6595dded2e3a86c8f5c0e40c1fd0` 的导出修复，不引入 main 历史。

未来缓存文章保存到 Obsidian 时使用文章文件名作为标题，来源信息区保留一条“原文链接”，不再额外生成 H1 和第二条原文 URL。浏览器 Markdown 仍保留 H1 和来源区链接。正文引用、小标题、引用内标题、图片、指标和原保存回执语义保留。旧笔记和 Obsidian 配置不迁移、不修改。

a5 的指标 Markdown 模板位于共享 `collection/collection-format.ts`。这里只为该函数增加内部可选渲染参数，默认仍输出原有标题和链接；其他采集报告与直接正文渲染入口的默认输出不变。只有缓存本地导出和已附带来源头的浏览器导出显式选择省略对应模板字段。缺正文的离线提示文件同样以文件名作标题。

运行改动限定四文件中的五个函数：`metricsMarkdown`、`buildArticleMarkdown`、`prepareCachedArticleLocalExport`、`TrpcRouter.getArticleMarkdown` 和 `TrpcRouter.buildOfflineFeedDirectory`。其他业务成员、schema、Prisma、共享写保护、备份、启动、前端、依赖及构建工具不改。

发布准备只编译当前后端并沿用现有 compact 打包配置，交付 `server/main.cjs` 和与现有 a5 包绑定的 `release.json`；其余产物复用已安装版本，不复制 Node、Prisma、前端或整个安装目录。交付需绑定既有包身份和原始哈希。该准备不是部署：由生产窗口负责受控替换、原保护门槛、停启和失败恢复，不能把文件构建成功当作实际用户路径验收。
