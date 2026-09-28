// 旧启动器保留可识别的入口，但不再允许原位构建、迁移或备份。
// 版本化产物和 SQLite 在线备份的步骤见 docs/LOCAL_RELEASE_REHEARSAL.md。
console.error(
  '旧版原位启动已停用：它无法核验服务进程身份、迁移前一致性备份和可运行的回滚应用。' +
    '\n请按 docs/LOCAL_RELEASE_REHEARSAL.md 使用隔离产物；受控生产切换完成前保留当前服务。',
);
process.exitCode = 1;
