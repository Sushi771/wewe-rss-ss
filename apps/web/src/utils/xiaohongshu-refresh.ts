/** Stop on an incomplete result while accounting for every requested creator. */
export async function refreshCreatorBatch(
  ids: string[],
  refresh: (id: string) => Promise<string>,
): Promise<{
  completed: number;
  remaining: number;
  failedId?: string;
  error?: string;
}> {
  let completed = 0;
  for (const id of ids) {
    let status: string;
    try {
      status = await refresh(id);
    } catch (cause) {
      return {
        completed,
        remaining: ids.length - completed - 1,
        failedId: id,
        error:
          cause instanceof Error ? cause.message : '更新未完成，既有归档保留。',
      };
    }
    if (status !== 'complete')
      return { completed, remaining: ids.length - completed - 1, failedId: id };
    completed++;
  }
  return { completed, remaining: 0 };
}
