/** Selection is a snapshot of loaded article IDs, never a pagination promise. */
export function getLoadedSelection(
  items: ReadonlyArray<{ id: string }>,
  selectedIds: ReadonlySet<string>,
) {
  const loadedIds = new Set(items.map((item) => item.id));
  const visibleSelectedIds = new Set(
    Array.from(selectedIds).filter((id) => loadedIds.has(id)),
  );
  const allSelected =
    loadedIds.size > 0 &&
    Array.from(loadedIds).every((id) => selectedIds.has(id));
  return {
    loadedIds,
    visibleSelectedIds,
    allSelected,
    isIndeterminate: visibleSelectedIds.size > 0 && !allSelected,
  };
}
