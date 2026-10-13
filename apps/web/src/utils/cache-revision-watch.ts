type Options = {
  read: (signal: AbortSignal) => Promise<{ revision: string }>;
  refresh: () => Promise<unknown>;
  onError?: (phase: 'revision' | 'view', error: unknown) => void;
  onHealthy?: () => void;
};

/** Local version reads only. A failed view read never acknowledges a revision. */
export function createCacheRevisionWatch(options: Options) {
  let active = false,
    disposed = false,
    generation = 0;
  let applied: string | undefined, latest: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let refreshing = false,
    failures = 0;
  let viewFailures = 0,
    retryViewAt = 0;

  const refresh = async () => {
    if (
      !active ||
      disposed ||
      refreshing ||
      applied === latest ||
      Date.now() < retryViewAt
    )
      return;
    refreshing = true;
    const target = latest;
    let succeeded = false;
    try {
      await options.refresh();
      applied = target;
      viewFailures = 0;
      retryViewAt = 0;
      succeeded = true;
      if (active && !disposed) options.onHealthy?.();
    } catch (error) {
      viewFailures++;
      retryViewAt =
        Date.now() + Math.min(30000, 1000 * 2 ** Math.min(viewFailures, 5));
      if (active && !disposed) options.onError?.('view', error);
    } finally {
      refreshing = false;
      // All versions observed during this read collapse to the latest one.
      if (succeeded && active && !disposed && applied !== latest)
        void refresh();
    }
  };
  const poll = async () => {
    if (!active || disposed) return;
    const currentGeneration = generation,
      started = Date.now();
    const request = new AbortController();
    controller = request;
    const deadline = setTimeout(() => request.abort(), 5000);
    try {
      const result = await options.read(request.signal);
      if (!active || disposed || currentGeneration !== generation) return;
      if (typeof result?.revision !== 'string' || !result.revision)
        throw new Error('Invalid local cache revision');
      failures = 0;
      latest = result.revision;
      // The initial list queries load current local data; persisted history is
      // a baseline, never a reason to replay old tasks or show update success.
      if (applied === undefined) applied = latest;
      else if (applied !== latest) void refresh();
      else if (!refreshing) options.onHealthy?.();
    } catch (error) {
      if (!active || disposed || currentGeneration !== generation) return;
      failures++;
      options.onError?.('revision', error);
    } finally {
      clearTimeout(deadline);
      if (controller === request) controller = undefined;
      if (active && !disposed && currentGeneration === generation)
        timer = setTimeout(
          () => void poll(),
          failures
            ? Math.min(30000, 1000 * 2 ** Math.min(failures, 5))
            : Math.max(0, 1000 - (Date.now() - started)),
        );
    }
  };
  const setActive = (next: boolean) => {
    if (disposed || active === next) return;
    active = next;
    generation++;
    clearTimeout(timer);
    controller?.abort();
    if (active) retryViewAt = 0;
    if (active) void poll();
  };
  return {
    setActive,
    dispose() {
      setActive(false);
      disposed = true;
    },
  };
}
