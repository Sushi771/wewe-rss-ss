/** Keep all three cache operations. Concurrent queries can share the existing
 * authenticated tRPC batch instead of waiting for three separate round trips.
 */
export async function refreshFeedViews(
  refetchFeeds: () => Promise<unknown>,
  resetArticles: () => Promise<unknown>,
  invalidateSummary: () => Promise<unknown>,
) {
  await Promise.all([refetchFeeds(), resetArticles(), invalidateSummary()]);
}
