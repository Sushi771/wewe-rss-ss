/** Local application status only: never contains body, nonce or pairing keys. */
export type BrowserArticleTaskState =
  | 'waiting'
  | 'claimed'
  | 'ready'
  | 'saving'
  | 'saved'
  | 'cancelled'
  | 'expired'
  | 'failed';
export type BrowserArticleTaskStatus = {
  taskId: string;
  expiresAt: string;
  state: BrowserArticleTaskState;
  code?: string;
  destinationBound?: boolean;
};
export type BrowserArticleTaskCapability = {
  available: boolean;
  code?: string;
  destinationBound?: boolean;
  refreshAvailable: false;
  refreshCode: 'DIRECTORY_ROUTE_UNVERIFIED';
};

/** Ignore a late poll for a previous/settled task; it must not revive capture. */
export function mergeBrowserArticleTaskStatus(
  current: BrowserArticleTaskStatus | null,
  next: BrowserArticleTaskStatus,
) {
  if (!current || current.taskId !== next.taskId) return current;
  if (['saved', 'cancelled', 'expired', 'failed'].includes(current.state))
    return current;
  if (
    current.code === 'SAVE_DIRECTORY_CHANGED' &&
    ['waiting', 'claimed', 'ready', 'saving'].includes(next.state)
  )
    return current;
  if (
    ['ready', 'saving'].includes(current.state) &&
    ['waiting', 'claimed'].includes(next.state)
  )
    return current;
  return next;
}

export function browserArticleTaskStatus(
  raw: unknown,
): BrowserArticleTaskStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as BrowserArticleTaskStatus;
  if (
    Object.keys(value).some(
      (k) =>
        !['taskId', 'expiresAt', 'state', 'code', 'destinationBound'].includes(
          k,
        ),
    ) ||
    typeof value.taskId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.taskId) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    (value.destinationBound !== undefined &&
      typeof value.destinationBound !== 'boolean') ||
    ![
      'waiting',
      'claimed',
      'ready',
      'saving',
      'saved',
      'cancelled',
      'expired',
      'failed',
    ].includes(value.state) ||
    (value.code !== undefined &&
      ![
        'TASK_CANCELLED',
        'TASK_EXPIRED',
        'OBSERVATION_REJECTED',
        'SAVE_RETRY_REQUIRED',
        'SAVE_DIRECTORY_CHANGED',
      ].includes(value.code))
  )
    return null;
  return {
    taskId: value.taskId,
    expiresAt: value.expiresAt,
    state: value.state,
    ...(value.code ? { code: value.code } : {}),
    ...(value.destinationBound === undefined
      ? {}
      : { destinationBound: value.destinationBound }),
  };
}
