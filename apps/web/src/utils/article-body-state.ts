/** Show current availability only. Retry history belongs in backend audit. */
export function articleBodyState(bodyCached: boolean) {
  return {
    current: bodyCached ? '正文已保存，可阅读' : '正文尚未保存',
    needsBody: !bodyCached,
  };
}
