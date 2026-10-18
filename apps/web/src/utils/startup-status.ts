export type StartupStatus = {
  status: 'verifying' | 'ready' | 'failed';
  writesAllowed: boolean;
  message: string;
};

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
