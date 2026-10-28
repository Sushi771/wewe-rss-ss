import { useState } from "react";
import { trpc } from "@web/utils/trpc";
export default function XhsWholeCreator({ creatorId }: { creatorId: string }) {
  const [page, setPage] = useState(0);
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
    <details className="min-w-0 rounded border p-3">
      <summary>整号互动覆盖与待补清单</summary>
      <p>
        发现平台返回的笔记，逐篇归档正文媒体并更新点赞、收藏、分享和评论数量。评论正文与回复采集暂停；私密、删除或平台未返回的内容仍为未知。
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
          <p className="break-all">
            状态：{job.state}；发现：{job.items.length}；列表结束：
            {job.listEnd ? "已返回结束" : "待补"}；请求：
            {job.budget?.used ?? "未知"}/{job.budget?.limit ?? "未知"}；
            {job.code}
          </p>
          <p>
            指标 {job.items.filter((i) => i.metrics).length}；历史主评论{" "}
            {job.items.filter((i) => i.top).length}；历史已知根回复{" "}
            {job.items.filter((i) => i.replies).length}；附页已保存{" "}
            {job.items.filter((i) => i.supplement === "saved").length} / 待补{" "}
            {job.items.filter((i) => i.supplement !== "saved").length}
          </p>
          {job.historyGrant && (
            <p>
              阶段请求：
              {Object.entries(job.historyGrant.limits)
                .map(
                  ([phase, cap]) =>
                    `${({ profile: "资料", list: "目录", detail: "正文详情", media: "媒体", metrics: "指标" } as Record<string, string>)[phase] ?? phase} ${job.historyGrant!.used[phase] ?? 0}/${cap}`,
                )
                .join("；")}
            </p>
          )}
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
          <details>
            <summary>逐篇事实与缺口</summary>
            <ul>
              {job.items.slice(page * 50, (page + 1) * 50).map((item) => (
                <li key={item.noteId} className="break-all">
                  {item.title || item.noteId}：{item.status} {item.stage}{" "}
                  {item.reason}；指标{" "}
                  {item.metrics
                    ? new Date(item.metrics).toLocaleString()
                    : "待补"}
                  ；主评 {item.top ? "已返回结束" : "待补"}；根回复{" "}
                  {item.replies ? "已返回结束" : "待补"}；附页
                  {item.supplement === "saved" ? "已保存" : "待补"}
                  ；删除状态未知
                </li>
              ))}
            </ul>
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <span>清单第 {page + 1} 页，每页50篇</span>
            <button
              disabled={(page + 1) * 50 >= job.items.length}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </details>
        </section>
      ))}
    </details>
  );
}
