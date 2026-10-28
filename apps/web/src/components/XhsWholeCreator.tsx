import { useState } from "react";
import { trpc } from "@web/utils/trpc";
export default function XhsWholeCreator({ creatorId }: { creatorId: string }) {
  const [limit, setLimit] = useState(100),
    [error, setError] = useState("");
  const [phase, setPhase] = useState<
    "profile" | "list" | "detail" | "media" | "metrics"
  >("detail");
  const [phaseLimit, setPhaseLimit] = useState(1);
  const jobs = trpc.xiaohongshu.wholeCreatorJobs.useQuery(
    { creatorId },
    { enabled: !!creatorId, retry: false, refetchInterval: 3000 },
  );
  const start = trpc.xiaohongshu.startWholeCreator.useMutation({
    retry: false,
  });
  const resume = trpc.xiaohongshu.resumeWholeCreator.useMutation({
    retry: false,
  });
  const extend = trpc.xiaohongshu.extendWholeCreatorBudget.useMutation({
    retry: false,
  });
  const extendPhase =
    trpc.xiaohongshu.extendWholeCreatorHistoryPhase.useMutation({
      retry: false,
    });
  const cancel = trpc.xiaohongshu.cancelWholeCreator.useMutation({
    retry: false,
  });
  if (!creatorId) return null;
  const execute = async (work: () => Promise<unknown>) => {
    setError("");
    try {
      await work();
      await jobs.refetch();
    } catch {
      setError("操作未确认，请读取任务状态后再继续。");
    }
  };
  return (
    <details className="min-w-0 border-b px-3 py-1 text-sm">
      <summary>同步博主内容</summary>
      <p>
        同步已发现笔记的内容与互动数量。未取得的数据会保留为未知。
      </p>
      <label>
        本轮请求上限{" "}
        <input
          aria-label="整号请求上限"
          type="number"
          min={1}
          max={100000}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        />
      </label>
      <button
        disabled={start.isLoading || !Number.isInteger(limit) || limit < 1}
        onClick={() =>
          void execute(() =>
            start.mutateAsync({
              creatorId,
              requestLimit: limit,
              intervalMs: 1000,
            }),
          )
        }
      >
        开始整号互动同步
      </button>
      {error && <p role="alert">{error}</p>}
      {jobs.error && <p role="alert">覆盖状态读取失败，未开始新请求。</p>}
      {(jobs.data ?? []).map((job) => (
        <section key={job.id} className="my-2 min-w-0 border-t">
          <p role="status">
            {{ queued: '等待中', running: '同步中', paused: '已暂停', partial: '部分完成', failed: '未完成', cancelled: '已取消', completed: '已完成' }[job.state] ?? '状态待确认'} · 已发现 {job.items.length} 篇
          </p>
          {job.sourceCheckpoint?.state === "unknown" && (
            <p role="alert">
              来源请求结果尚未确认，已暂停且不会自动重发；请先核对该阶段回执。
            </p>
          )}
          {job.sourceCheckpoint?.state === "restricted" && (
            <p role="alert">来源拒绝了该请求，任务已停止，不会自动重发。</p>
          )}
          {job.code === "XHS_WHOLE_PHASE_BUDGET_EXHAUSTED" && (
            <p role="alert">
              阶段额度已用完，调整对应额度后可明确继续；已用次数不会重置。
            </p>
          )}
          <p>
            更新于 {new Date(job.updatedAt).toLocaleString()}
            。仅表示已发现可访问范围的互动阶段。
          </p>
          {job.historyGrant &&
            job.state === "paused" &&
            !job.sourceCheckpoint && (
              <div>
                <label>
                  调整阶段
                  <select
                    aria-label="调整阶段"
                    value={phase}
                    onChange={(event) =>
                      setPhase(event.target.value as typeof phase)
                    }
                  >
                    <option value="profile">资料</option>
                    <option value="list">目录</option>
                    <option value="detail">正文详情</option>
                    <option value="media">媒体</option>
                    <option value="metrics">指标</option>
                  </select>
                </label>
                <label>
                  阶段累计上限
                  <input
                    aria-label="阶段累计上限"
                    type="number"
                    min={1}
                    max={job.budget?.limit ?? 100000}
                    value={phaseLimit}
                    onChange={(event) =>
                      setPhaseLimit(Number(event.target.value))
                    }
                  />
                </label>
                <button
                  disabled={
                    extendPhase.isLoading ||
                    !Number.isSafeInteger(phaseLimit) ||
                    phaseLimit <= (job.historyGrant.limits[phase] ?? 0) ||
                    phaseLimit > (job.budget?.limit ?? 0)
                  }
                  onClick={() =>
                    void execute(() =>
                      extendPhase.mutateAsync({
                        id: job.id,
                        phase,
                        newLimit: phaseLimit,
                        confirmHistoryGrant: true,
                      }),
                    )
                  }
                >
                  确认调整阶段上限
                </button>
                <p>
                  只调整所选阶段的累计上限，不清除已用额度，也不会自动继续。
                </p>
              </div>
            )}
          {[
            "XHS_REQUEST_BUDGET_EXHAUSTED",
            "XHS_WHOLE_PHASE_BUDGET_EXHAUSTED",
          ].includes(job.code ?? "") &&
            !job.sourceCheckpoint && (
              <button
                onClick={() =>
                  void execute(() =>
                    extend.mutateAsync({ id: job.id, additional: limit }),
                  )
                }
              >
                明确追加 {limit} 次请求
                {job.historyGrant ? "（需另行继续）" : "并继续"}
              </button>
            )}
          {["paused", "partial", "failed", "cancelled"].includes(job.state) && (
            <button
              disabled={!job.resumable}
              onClick={() =>
                void execute(() => resume.mutateAsync({ id: job.id }))
              }
            >
              按原预算续补
            </button>
          )}
          {["queued", "running"].includes(job.state) && (
            <button
              onClick={() =>
                void execute(() => cancel.mutateAsync({ id: job.id }))
              }
            >
              取消
            </button>
          )}

        </section>
      ))}
    </details>
  );
}
