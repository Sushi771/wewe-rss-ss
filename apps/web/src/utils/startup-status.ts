export type PeriodicBackupStatus = {
  generationPaused: boolean;
  generationPauseReason: 'pending-confirmation' | 'lifecycle-held' | null;
  normalCopies: number | null;
  pendingCopies: number | null;
  lastGeneratedAtMs: number | null;
  lastVerifiedAtMs: number | null;
  coverageAtMs: number | null;
  verificationBasis: string;
  coverageBasis: string;
  observedAtMs?: number;
};
export type StartupStatus = {
  status: 'verifying' | 'ready' | 'failed';
  writesAllowed: boolean;
  message: string;
  periodicBackup?: PeriodicBackupStatus | null;
};

/** Display labels never grant backup freshness or write permission. */
export function periodicBackupLines(value?: PeriodicBackupStatus | null) {
  if (!value) return ['周期备份状态尚不可用，请稍后重新读取。'];
  const time = (ms: number | null | undefined) =>
    typeof ms === 'number' &&
    Number.isFinite(ms) &&
    ms >= 0 &&
    ms <= 8640000000000000
      ? new Date(ms).toLocaleString()
      : '未知';
  return [
    value.generationPaused
      ? value.generationPauseReason === 'pending-confirmation'
        ? '周期备份新增已暂停：等待本次精确轮换确认，现有恢复点保留。'
        : '周期备份新增已暂停：生命周期记录需要核对。'
      : '周期备份生成未被生命周期暂停；仍须满足空间与验证条件。',
    `现有周期副本：${value.normalCopies ?? '未知'} 份常规，${value.pendingCopies ?? '未知'} 份待确认；自动删除关闭。`,
    `最近生成：${time(value.lastGeneratedAtMs)}`,
    `最近验证：${time(value.lastVerifiedAtMs)}（${value.verificationBasis === 'current-owner-hash' ? '当前进程完整哈希核验' : value.verificationBasis === 'creation-receipt' ? '创建时回执' : '依据未知'}）`,
    `数据覆盖至：${time(value.coverageAtMs)}（${value.coverageBasis === 'verified-unchanged' ? '已核实源数据未变' : value.coverageBasis === 'copy-start' ? '复制开始时刻' : '依据未知'}）`,
    `状态记录时间：${time(value.observedAtMs)}。重新读取不生成备份，验证旧点不等于生成新副本。`,
  ];
}

export const STORAGE_DETAILS_PATH = '/tools/article-download#storage-backup';

export async function readStartupStatus(
  signal: AbortSignal,
): Promise<StartupStatus> {
  const response = await fetch('/startup-status', {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('STARTUP_STATUS_UNAVAILABLE');
  const state = await response.json();
  if (
    !['verifying', 'ready', 'failed'].includes(state?.status) ||
    typeof state.writesAllowed !== 'boolean' ||
    typeof state.message !== 'string'
  )
    throw new Error('STARTUP_STATUS_INVALID');
  return state;
}

/** A capacity forecast is not a write failure or proof that the disk is full. */
export function startupBlockingMessage(state: StartupStatus) {
  if (state.writesAllowed) return '';
  if (state.status === 'verifying') return '正在检查数据，更新暂不可用。';
  return state.message.includes('空间')
    ? '存储空间受限，更新和修改已暂停。'
    : '数据检查未通过，更新和修改已暂停。';
}

/** Only concrete storage failures from an unsuccessful request use this copy. */
export function isStorageFailure(message: string) {
  return /INCREMENTAL_DISK_SPACE_INSUFFICIENT|SQLITE_SPACE_BUDGET_EXCEEDED|SQLITE_FULL|备份空间预算不足|磁盘空间不足/.test(
    message,
  );
}
