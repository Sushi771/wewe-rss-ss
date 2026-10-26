/** Match the saved canonical tuple used by the server's xhsOriginalLink.
 * Never carry source query parameters, access tokens or arbitrary URL schemes. */
export function xhsOriginalNoteUrl(id: string): string | undefined {
  let tuple: unknown;
  try {
    tuple = JSON.parse(id);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 3 ||
    tuple[0] !== 'xiaohongshu' ||
    tuple[1] !== 'note' ||
    typeof tuple[2] !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(tuple[2]) ||
    JSON.stringify(tuple) !== id
  )
    return undefined;
  return `https://www.xiaohongshu.com/explore/${tuple[2]}`;
}

export function noteArchiveStatus(note: {
  status: string;
  kind: 'image-text' | 'video';
}) {
  return note.status === 'complete'
    ? note.kind === 'video'
      ? '视频已归档（播放未验证）'
      : '图文已归档'
    : note.kind === 'video' || note.status === 'video-skipped'
      ? '目录记录 · 视频未归档'
      : '目录记录 · 正文/媒体未完整归档';
}
