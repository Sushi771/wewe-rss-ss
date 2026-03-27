export const statusMap = {
  // 0:失效 1:启用 2:禁用
  INVALID: 0,
  ENABLE: 1,
  DISABLE: 2,
} as const;

export const statusDetailMap = {
  [statusMap.INVALID]: { label: '失效', color: 'danger' },
  [statusMap.ENABLE]: { label: '启用', color: 'success' },
  [statusMap.DISABLE]: { label: '禁用', color: 'warning' },
} as const;

export const feedTypes = ['rss', 'atom', 'json'] as const;

export const feedMimeTypeMap = {
  rss: 'application/rss+xml; charset=utf-8',
  atom: 'application/atom+xml; charset=utf-8',
  json: 'application/feed+json; charset=utf-8',
} as const;

export const defaultCount = 20;
