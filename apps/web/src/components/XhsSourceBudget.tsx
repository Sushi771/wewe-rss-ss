import { useEffect, useRef, useState } from 'react';

export type SourceBudgetScope =
  | { purpose: 'resolution' }
  | { purpose: 'original-link'; creatorId: string };
export type SourceBudget = {
  budgetId: string;
  limit: number;
  used: number;
  remaining: number;
  nextAt: number;
  intervalMs: number;
};
export type SourceBudgetApi = {
  sourceRequestBudget: {
    query: (scope: SourceBudgetScope) => Promise<SourceBudget | null>;
  };
  configureSourceRequestBudget: {
    mutate: (input: {
      scope: SourceBudgetScope;
      totalLimit: number;
      intervalMs: number;
    }) => Promise<SourceBudget>;
  };
};

/** Reading a persisted allowance is local; only Submit configures it. Key by scope. */
export default function XhsSourceBudget({
  scope,
  api,
}: {
  scope: SourceBudgetScope;
  api: SourceBudgetApi;
}) {
  const [budget, setBudget] = useState<SourceBudget | null>();
  const [total, setTotal] = useState('');
  const [seconds, setSeconds] = useState('5');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true),
    pending = useRef(false),
    generation = useRef(0);
  const scopeRef = useRef(scope);
  const apply = (value: SourceBudget | null) => {
    setBudget(value);
    if (value) {
      setTotal(String(value.limit));
      setSeconds(String(value.intervalMs / 1000));
    }
  };
  useEffect(() => {
    alive.current = true;
    const request = ++generation.current;
    void api.sourceRequestBudget
      .query(scopeRef.current)
      .then((value) => {
        if (alive.current && request === generation.current) apply(value);
      })
      .catch(() => {
        if (alive.current && request === generation.current)
          setError('额度读取失败，请重新打开设置。');
      });
    return () => {
      alive.current = false;
    };
  }, [api]);
  const save = async () => {
    if (pending.current || !alive.current) return;
    const totalLimit = Number(total),
      intervalMs = Number(seconds) * 1000;
    if (
      !Number.isSafeInteger(totalLimit) ||
      totalLimit < Math.max(1, budget?.used ?? 0) ||
      totalLimit > 100000 ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 1000 ||
      intervalMs > 60000
    ) {
      setError(
        '总额度须为 1–100000 的整数且不低于已用次数，间隔须为 1–60 秒。',
      );
      return;
    }
    pending.current = true;
    const request = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const value = await api.configureSourceRequestBudget.mutate({
        scope: scopeRef.current,
        totalLimit,
        intervalMs,
      });
      if (alive.current && request === generation.current) apply(value);
    } catch {
      if (alive.current && request === generation.current)
        setError('额度保存失败，请检查连接后重试。');
    } finally {
      if (alive.current && request === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <details className="xhs-source-budget">
      <summary>
        共享来源请求额度 ·{' '}
        {budget === undefined
          ? '读取中'
          : budget === null
            ? '尚未配置'
            : `剩余 ${budget.remaining} 次 / 总计 ${budget.limit} 次`}
      </summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p>
          {budget
            ? `共已使用 ${budget.used} 次。识别作者与所有博主的原文共用此总额。`
            : '首次需要访问来源时，请先显式保存一次额度。有效原文链接可直接复用，不消耗请求。'}
        </p>
        {budget && budget.nextAt > Date.now() && (
          <p>下次可请求时间：{new Date(budget.nextAt).toLocaleString()}</p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label>
            总额度（次）
            <input
              aria-label="来源请求总额度"
              type="number"
              min={Math.max(1, budget?.used ?? 0)}
              max={100000}
              step={1}
              value={total}
              disabled={busy}
              onChange={(event) => setTotal(event.target.value)}
            />
          </label>
          <label>
            请求间隔（秒）
            <input
              aria-label="来源请求间隔秒"
              type="number"
              min={1}
              max={60}
              step={0.001}
              value={seconds}
              disabled={busy}
              onChange={(event) => setSeconds(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? '保存中…' : '保存请求额度'}
          </button>
        </div>
        <p>
          保存不会重置已用次数或叠加额度。保存后再次点击笔记或“识别作者”，不会自动请求来源。
        </p>
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
