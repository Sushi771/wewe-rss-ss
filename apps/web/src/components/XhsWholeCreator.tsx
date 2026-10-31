import { useRef, useState } from "react";
import { trpc } from "@web/utils/trpc";

export default function XhsWholeCreator({ creatorId, selectedNoteIds = [] }: { creatorId: string; selectedNoteIds?: string[] }) {
  const [limit, setLimit] = useState(100),
    [error, setError] = useState("");
  const [phase, setPhase] = useState<
    "profile" | "list" | "detail" | "media" | "metrics"
  >("detail");
  const [phaseLimit, setPhaseLimit] = useState(1);
  const [recoveryJob, setRecoveryJob] = useState("");
  const [recoveryUrl, setRecoveryUrl] = useState("");
  const [excludedNote, setExcludedNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoveryBusy = useRef(false);
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
  const prepareRecovery = trpc.xiaohongshu.prepareWholeCreatorReviewedAttempt.useMutation({ retry: false });
  const runRecovery = trpc.xiaohongshu.executeWholeCreatorReviewedAttempt.useMutation({ retry: false });
  const prepareContext = trpc.xiaohongshu.prepareWholeCreatorReviewedContext.useMutation({ retry: false });
  const runContext = trpc.xiaohongshu.executeWholeCreatorReviewedContext.useMutation({ retry: false });
  const recoverFromAuthor = async (jobId:string, noteId?:string, contextId?:string) => {
    if(recoveryBusy.current || recoveryJob!==jobId || !confirmed)return;
    recoveryBusy.current=true;setRecovering(true);setConfirmed(false);setError('');
    try {
      if(contextId)await runContext.mutateAsync({jobId,contextId,confirmUnknownRetry:true});
      else if(noteId)await prepareContext.mutateAsync({jobId,excludedNoteId:noteId,confirmUnknownRetry:true});
    } catch {setError('恢复未完成，请查看当前状态；不会自动重发。');}
    finally {await jobs.refetch().catch(()=>setError('状态刷新失败，请先刷新核对。'));recoveryBusy.current=false;setRecovering(false);}
  };
  const recover = async (jobId: string, attemptId?: string, legacyUnknown = false, excludedNoteId?: string) => {
    if (recoveryBusy.current || recoveryJob !== jobId || !confirmed) return;
    recoveryBusy.current = true;
    setRecovering(true);
    setError("");
    const url = recoveryUrl;
    setRecoveryUrl("");
    setConfirmed(false);
    try {
      if (attemptId) await runRecovery.mutateAsync({ jobId, attemptId, url, confirmUnknownRetry: true });
      else await prepareRecovery.mutateAsync({ jobId, confirmUnknownRetry: true, ...(legacyUnknown ? {confirmLegacyUnknown: true as const} : {}), ...(excludedNoteId ? {excludedNoteId} : {}) });
    } catch {
      setError("本次操作结果待核对，请查看最新恢复回执；不会自动重发。");
    } finally {
      await jobs.refetch().catch(() => { setError("恢复回执读取失败，请刷新后核对；不会自动重发。"); });
      recoveryBusy.current = false;
      setRecovering(false);
    }
  };
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
          {(job.canPrepareGeneration || job.generationRecovery) && <XhsWholeGeneration job={job} refresh={() => jobs.refetch()} />}
          {!!job.generationRecovery?.retryableExcludedIds?.length && !job.reviewedRecovery && (
            <div className="my-2 space-y-2 rounded border p-2">
              <p>历史请求结果未知；请选择一篇。最多请求作者 1 次、目录 2 页及目标详情 1 次，不请求图片；已取得的上下文优先复用。</p>
              <label>选择已排除的笔记
                <select value={recoveryJob === job.id ? excludedNote : ''} disabled={recovering} onChange={e=>{setRecoveryJob(job.id);setExcludedNote(e.target.value);setConfirmed(false);}}>
                  <option value="">请选择</option>
                  {job.generationRecovery.retryableExcludedIds.map(id=><option key={id} value={id}>{job.items.find(item=>item.noteId===id)?.title || '未命名笔记'}</option>)}
                </select>
              </label>
              <label><input type="checkbox" checked={recoveryJob===job.id && confirmed} disabled={recovering} onChange={e=>{setRecoveryJob(job.id);setConfirmed(e.target.checked);}} />我确认只为所选笔记准备一次详情恢复。</label>
              <button disabled={recovering || recoveryJob!==job.id || !confirmed || !job.generationRecovery.retryableExcludedIds.includes(excludedNote)} onClick={()=>{const tuple=JSON.parse(excludedNote);void recoverFromAuthor(job.id,tuple[2]);}}>核对并准备单篇恢复</button>
            </div>
          )}
          {job.contextRecovery && !job.reviewedRecovery && <div className="my-2 space-y-2 rounded border p-2">
            {job.contextRecovery.state==='prepared' ? <>
              <p>恢复范围仅限该笔记：最多作者 1 次、目录 2 页、详情 1 次，图片 0 次。来源受限或结果未知即停止。</p>
              <label><input type="checkbox" checked={recoveryJob===job.id && confirmed} disabled={recovering} onChange={e=>{setRecoveryJob(job.id);setConfirmed(e.target.checked);}} />确认按上述范围恢复</label>
              <button disabled={recovering||recoveryJob!==job.id||!confirmed} onClick={()=>void recoverFromAuthor(job.id,undefined,job.contextRecovery?.id)}>执行单篇恢复</button>
            </> : job.contextRecovery.state==='ready' ? <>
              <p role="status">上下文已就绪，详情尚未发送。若重启后上下文已失效，请重新准备；不会自动重发未知请求。</p>
              <label><input type="checkbox" checked={recoveryJob===job.id && confirmed} disabled={recovering} onChange={e=>{setRecoveryJob(job.id);setConfirmed(e.target.checked);}} />确认继续或重新准备该笔记</label>
              <button disabled={recovering||recoveryJob!==job.id||!confirmed} onClick={()=>void recoverFromAuthor(job.id,undefined,job.contextRecovery?.id)}>继续单篇恢复</button>
              <button disabled={recovering||recoveryJob!==job.id||!confirmed} onClick={()=>void recoverFromAuthor(job.id,job.contextRecovery?.noteId)}>重新准备</button>
            </> : job.contextRecovery.state==='incomplete' ? <>
              <p role="status">目录检查未完成或未找到目标；可以明确确认后重新准备，预算仍为作者最多 1 次、目录 2 页、详情 1 次。</p>
              <label><input type="checkbox" checked={recoveryJob===job.id && confirmed} disabled={recovering} onChange={e=>{setRecoveryJob(job.id);setConfirmed(e.target.checked);}} />确认重新准备该笔记</label>
              <button disabled={recovering||recoveryJob!==job.id||!confirmed} onClick={()=>void recoverFromAuthor(job.id,job.contextRecovery?.noteId)}>重新准备</button>
            </> : <p role="status">{job.contextRecovery.state==='in-progress'?'正在恢复，请勿重复提交。':job.contextRecovery.state==='restricted'?'来源受限，已停止。':job.contextRecovery.state==='unknown'?'请求结果未知，已停止且不会自动重发。':'上下文未完成，请先核对；不会自动重发。'}</p>}
          </div>}
          <p role="status">
            {{ queued: '等待中', running: '同步中', paused: '已暂停', partial: '部分完成', failed: '未完成', cancelled: '已取消', completed: '已完成' }[job.state] ?? '状态待确认'} · 已发现 {job.items.length} 篇
          </p>
          {job.generationRecovery && <XhsSelectedMedia job={job} selectedNoteIds={selectedNoteIds} refresh={() => jobs.refetch()} />}

          {!job.generationRecovery && job.sourceCheckpoint?.state === "unknown" && (
            <p role="alert">
              来源请求结果尚未确认，已暂停且不会自动重发；请先核对该阶段回执。
            </p>
          )}
          {!job.generationRecovery && job.sourceCheckpoint?.state === "restricted" && (
            <p role="alert">来源拒绝了该请求，任务已停止，不会自动重发。</p>
          )}
          {job.reviewedRecovery && !job.canPrepareGeneration && (
            <div className="my-2 space-y-2 rounded border p-2">
              <p>原请求结果仍未知。本次恢复只补取指定笔记的正文和指标，沿用累计预算；图片和评论不会发起请求，也不会自动继续整号任务。</p>
              {job.reviewedRecovery.state === "checkpointed" ? (
                <p role="status">本次恢复已保存：正文{job.reviewedRecovery.receipt?.body === "retained" ? "保留已有内容" : "已保存"}，图片{job.reviewedRecovery.receipt?.media === "needs-review" ? "清单待核对" : job.reviewedRecovery.receipt?.media === "pending" ? "待补齐" : "无"}。原请求仍待核对。</p>
              ) : job.reviewedRecovery.state === "in-progress" ? (
                <p role="status">单篇详情请求执行中，请等待结果，勿重复提交。</p>
              ) : job.reviewedRecovery.state === "consumed" ? (
                <p role="alert">本次恢复已提交，但保存结果尚未确认；结果未知，不能再次执行。</p>
              ) : job.reviewedRecovery.state === "restricted" ? (
                <p role="alert">本次恢复遇到来源限制，已停止，不能再次执行。原请求仍待核对。</p>
              ) : job.reviewedRecovery.state === "blocked" ? (
                <p>当前任务缺少可用的恢复依据，需要人工核对后处理。</p>
              ) : job.reviewedRecovery.state === "expired" ? (
                <p>本次确认已过期，需要重新核对；不会自动创建或执行新的尝试。</p>
              ) : (
                <>
                  <p className="break-all">待核对笔记：{job.reviewedRecovery.noteId}，阶段：{job.reviewedRecovery.phase === "detail" ? "正文" : job.reviewedRecovery.phase === "metrics" ? "互动数量" : "待确认"}</p>
                  {job.reviewedRecovery.state === "prepared" && (
                    <>
                      <p>确认有效期至 {new Date(job.reviewedRecovery.expiresAt!).toLocaleString()}；执行前服务端会再次核对条件。</p>
                      <label>该笔记的官方分享链接
                        <input aria-label="恢复笔记的官方分享链接" type="url" autoComplete="off" value={recoveryJob === job.id ? recoveryUrl : ""} disabled={recovering}
                          onChange={e => { setRecoveryJob(job.id); setRecoveryUrl(e.target.value); setConfirmed(false); }} />
                      </label>
                    </>
                  )}
                  {job.reviewedRecovery.legacyUnknown && <p>旧请求缺少进程记录，原结果仍然未知。本机维护记录不代表远端失败，再次请求可能重复产生费用。</p>}
                  <label>
                    <input type="checkbox" checked={recoveryJob === job.id && confirmed} disabled={recovering}
                      onChange={e => { setRecoveryJob(job.id); setConfirmed(e.target.checked); }} />
                    我已知原请求结果未知，确认只为这篇笔记增加一次请求，不重置已用预算。
                  </label>
                  <button disabled={recovering || recoveryJob !== job.id || !confirmed || (job.reviewedRecovery.state === "prepared" && !recoveryUrl.trim())}
                    onClick={() => void recover(job.id, job.reviewedRecovery?.state === "prepared" ? job.reviewedRecovery.attemptId : undefined, job.reviewedRecovery?.legacyUnknown === true)}>
                    {job.reviewedRecovery.state === "prepared" ? "仅执行这一次恢复" : "核对并准备一次恢复"}
                  </button>
                </>
              )}
            </div>
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

const phases = ['profile', 'list', 'detail', 'media', 'metrics'] as const;
const labels = { profile: '主页与资料', list: '目录', detail: '正文', media: '图片与视频', metrics: '互动数量' };
type Limits = Record<(typeof phases)[number], number>;
type Job = {
  id: string;
  canPrepareGeneration: boolean;
  budget: { limit: number; used: number } | null;
  historyGrant?: { limits: Record<string, number>; used: Record<string, number> };
  items: {noteId: string; title: string}[];
  generationRecovery?: {
    id: string; state: string; profileUrl: string; discovered: number; missing: number;
    directoryComplete: boolean; selectionComplete?: boolean; basicCompleted?: boolean; excludeUnknownRequired?: boolean; originalNoteStatus: string; newResult?: string; resumable: boolean;
    selectedIds?: string[]; excludedIds?: string[];
    reviewable?: boolean;
    failure?: {stage:string;outcome:string;code:string;status?:number;requiresStop?:boolean};
  };
};
/** Explicit preparation and execution stay separate; an uncertain response never retries itself. */
export function XhsWholeGeneration({ job, refresh }: { job: Job; refresh: () => Promise<unknown> }) {
  const [url, setUrl] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [excludeUnknown, setExcludeUnknown] = useState(false);
  const [omitted, setOmitted] = useState<string[]>([]);
  const [limits, setLimits] = useState<Partial<Limits>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const prepare = trpc.xiaohongshu.prepareWholeCreatorGeneration.useMutation({ retry: false });
  const execute = trpc.xiaohongshu.executeWholeCreatorGeneration.useMutation({ retry: false });
  const review = trpc.xiaohongshu.reviewWholeCreatorGeneration.useMutation({ retry: false });
  if (!job.canPrepareGeneration && !job.generationRecovery) return null;
  const g = job.generationRecovery;
  const selectedIds = g?.selectedIds ?? job.items.filter(item => !(g?.excludedIds ?? []).includes(item.noteId) && !omitted.includes(item.noteId)).map(item => item.noteId);
  const cap = job.budget?.limit ?? 0;
  const remaining = Math.max(0, cap - (job.budget?.used ?? 0));
  const phaseLimits = Object.fromEntries(phases.map(p => [p, limits[p] ?? Math.min(cap,
    Math.max(job.historyGrant?.limits[p] ?? 0, (job.historyGrant?.used[p] ?? 0) + ({ profile: 4, list: 20, detail: 100, media: 200, metrics: 100 }[p])))])) as Limits;
  const valid = phases.every(p => Number.isSafeInteger(phaseLimits[p]) && phaseLimits[p] >= (job.historyGrant?.limits[p] ?? 0) && phaseLimits[p] <= cap);
  const run = async () => {
    if (lock.current || !confirmed || (g?.reviewable && g.excludeUnknownRequired && !excludeUnknown)) return;
    lock.current = true; setBusy(true); setError(''); setConfirmed(false);
    let submitted = false;
    try {
      if (g?.reviewable) { submitted=true; await review.mutateAsync({ jobId:job.id,generationId:g.id,confirmUnknown:true, ...(g.excludeUnknownRequired ? { excludeUnknown: true } : {}) }); }
      else if (g) { submitted=true; await execute.mutateAsync({ jobId: job.id, generationId: g.id, confirmUnknown: true, selectedIds }); }
      else { submitted=true; await prepare.mutateAsync({ jobId: job.id, profileUrl: url, confirmUnknown: true, phaseLimits }); }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      if (!submitted) setError('目录选择未完成，未开始采集。');
      else if (message === 'XHS_SAVE_DIRECTORY_SELECTION_REQUIRED') setError('请先选择本次小红书保存目录，再明确继续。');
      else if (message === 'XHS_RESUME_DIRECTORY_CHANGED') setError('保存目录与本次任务已使用的目录不同，请选回原目录。');
      else setError('操作未确认，请刷新查看进度后再决定。不会自动重复提交。');
    }
    finally {
      await refresh().catch(() => setError('进度读取失败，请刷新核对。不会自动重发请求。'));
      lock.current = false; setBusy(false);
    }
  };
  return <div className="my-2 space-y-2 rounded border p-2">
    <p>从主页继续整号采集。原请求结果仍是未知，旧次数继续保留；新尝试使用剩余 {remaining} 次本地请求额度。图片、视频和互动数量随正文补齐，评论正文保持关闭。</p>
    {g ? <>
      {g.failure && g.failure.outcome !== 'checkpointed' && <p role="alert">{g.failure.status && g.failure.status >= 400 ? '来源已明确拒绝本次请求，请先处理来源限制。' : g.failure.requiresStop ? '本次执行需要先由受控维护确认已停止，确认后才能准备继续；次数和原未知结果已保留。' : g.failure.code === 'XHS_SAVE_DIRECTORY_SELECTION_REQUIRED' ? '请先选择本次小红书保存目录，再明确继续。' : g.failure.code === 'XHS_RESUME_DIRECTORY_CHANGED' ? '保存目录与本次任务已使用的目录不同，已暂停。请选回本次任务原目录，再明确继续；已保存文件保留。' : g.failure.stage === 'storage' || g.failure.stage === 'checkpoint' ? '资料保存失败，请核对本机保存状态后准备继续。' : g.failure.stage === 'parse' ? '来源已返回资料，但当前程序无法识别其格式，需要修复后继续。' : g.failure.outcome === 'local-failure' ? '本机保存步骤未完成，请检查保存目录与本机状态后继续。' : g.failure.outcome === 'not-sent' ? '请求未发送，请核对连接和任务状态后准备继续。' : g.failure.outcome === 'response-received' ? '来源已响应，但资料未能完成处理；请核对原因后准备继续。' : '请求结果尚未确认，需先核对执行已停止，再准备继续。'}</p>}
      <p role="status">{g.state === 'completed' ? (g.basicCompleted ? '基础采集阶段已完成，媒体待补' : '本次可访问内容已完成') : g.state === 'running' ? '正在继续采集' : '等待明确继续'}；目录{g.selectionComplete ? '已完成所选范围' : g.directoryComplete ? '已到末页' : '未完成'}，本次返回 {g.discovered} 篇。</p>
      {!!g.missing && <p>已有缓存中 {g.missing} 篇未在本次完整目录返回，保留原文件并单独记录，不认定为删除。</p>}
      {g.newResult === 'unknown' && !g.failure && <p role="alert">本次还有请求结果未确认，已停止；需核对后才能继续，不能重复提交。</p>}
      {g.newResult === 'restricted' && <p role="alert">来源限制或平台验证已阻止本次采集。请先按平台正常流程处理，应用不会自动重试。</p>}
    </> : <>
      <label>作者主页或官方主页分享链接
        <input aria-label="恢复整号的主页链接" type="url" autoComplete="off" value={url} disabled={busy}
          onChange={e => { setUrl(e.target.value); setConfirmed(false); }} />
      </label>
      <p>确认各阶段累计上限；下面的已用次数不会清零，所有阶段也受任务和共享总上限约束。</p>
      {phases.map(p => <label key={p} className="block">{labels[p]}：已用 {job.historyGrant?.used[p] ?? 0}，累计上限
        <input aria-label={`${labels[p]}累计上限`} type="number" min={job.historyGrant?.limits[p] ?? 0} max={cap} value={phaseLimits[p]} disabled={busy}
          onChange={e => { setLimits(v => ({ ...v, [p]: Number(e.target.value) })); setConfirmed(false); }} />
      </label>)}
    </>}
    {g?.basicCompleted && <p role="status">已保存本次可取得的基础信息；正文或媒体缺失的笔记仍待补充。</p>}
    {g && !g.reviewable && <div>
      <p>本次仅采集已选择的 {selectedIds.length} 篇；结果未知的历史请求不重发，完整缓存直接复用，未选择的内容保持未完成。</p>
      {job.items.map(item => <label key={item.noteId} className="block">
        <input type="checkbox" checked={selectedIds.includes(item.noteId)} disabled={busy || !!g.selectedIds || (g.excludedIds ?? []).includes(item.noteId)}
          onChange={e => { setOmitted(v => e.target.checked ? v.filter(id => id !== item.noteId) : [...v, item.noteId]); setConfirmed(false); }} />
        {item.title || '未命名笔记'}{(g.excludedIds ?? []).includes(item.noteId) ? '（历史结果未知，跳过）' : ''}
      </label>)}
    </div>}
    {g?.reviewable && g.excludeUnknownRequired && <label className="block"><input type="checkbox" checked={excludeUnknown} disabled={busy} onChange={e => { setExcludeUnknown(e.target.checked); setConfirmed(false); }} />
      跳过结果未知的笔记，保留其未完成状态；不会自动重试该请求。
    </label>}
    {(!g || g.resumable || g.reviewable) && <>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />
        我知道旧请求仍未知；确认在上述累计上限内验证这个作者并继续剩余内容，平台限制或验证出现时停止。
      </label>
      <button disabled={busy || !confirmed || (!!g?.reviewable && !!g.excludeUnknownRequired && !excludeUnknown) || (!g && (!url.trim() || !valid)) || remaining === 0 || (!!g && !g.reviewable && !selectedIds.length)} onClick={() => void run()}>
        {g?.reviewable ? '核对本次执行并准备继续' : g ? '明确开始或继续本次整号采集' : '核对并准备整号新尝试'}
      </button>
      {!g && <p>准备操作不发来源请求，核对后还需点击开始。</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}


/** Explicit per-generation action; selection is never widened or auto-retried. */
export function XhsSelectedMedia({ job, selectedNoteIds, refresh }: {
  job: { id: string; state: string; items: { noteId: string; title: string; mediaResult?: 'complete' | 'needs-review' | 'needs-detail-refresh' }[];
    generationRecovery?: { id: string; directoryComplete: boolean; selectionComplete?: boolean; resumable: boolean; excludedIds?: string[]; mediaRecoverableIds?: string[]; newResult?: string } | null };
  selectedNoteIds: string[]; refresh: () => Promise<unknown>;
}) {
  const [confirmedKey, setConfirmedKey] = useState('');
  const [basicConfirmedKey, setBasicConfirmedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const resumeMedia = trpc.xiaohongshu.resumeWholeCreatorMedia.useMutation({ retry: false });
  const resumeBasic = trpc.xiaohongshu.resumeWholeCreatorMissingBasic.useMutation({ retry: false });
  const generation = job.generationRecovery;
  const key = JSON.stringify([job.id, generation?.id, selectedNoteIds]);
  const items = selectedNoteIds.map(id => job.items.find(item => item.noteId === id));
  const eligible = !!generation && generation.resumable && job.state === 'partial' &&
    (generation.directoryComplete || generation.selectionComplete) && !generation.newResult &&
    selectedNoteIds.length > 0 && selectedNoteIds.length <= 1000 &&
    new Set(selectedNoteIds).size === selectedNoteIds.length &&
    items.every(Boolean);
  const basicEligible = eligible && !selectedNoteIds.some(id => (generation?.excludedIds ?? []).includes(id));
  const mediaEligible = eligible && !selectedNoteIds.some(id => (generation?.excludedIds ?? []).includes(id) && !(generation?.mediaRecoverableIds ?? []).includes(id));
  const run = async () => {
    if (lock.current || !mediaEligible || confirmedKey !== key || !generation) return;
    lock.current = true; setBusy(true); setConfirmedKey(''); setMessage('');
    try {
      await resumeMedia.mutateAsync({jobId: job.id, generationId: generation.id, noteIds: [...selectedNoteIds]});
      setMessage('已提交所选图片补缺，请查看任务状态；已保存的图片会复用。');
    } catch {
      setMessage('本次操作未确认或受到来源限制，请先核对任务状态；不会自动重发。');
    } finally {
      await refresh().catch(() => setMessage('任务状态读取失败，请刷新核对；不会自动重发。'));
      lock.current = false; setBusy(false);
    }
  };
  const runBasic = async () => {
    if (lock.current || !basicEligible || basicConfirmedKey !== key || !generation) return;
    lock.current = true; setBusy(true); setBasicConfirmedKey(''); setMessage('');
    try {
      const receipt = await resumeBasic.mutateAsync({jobId: job.id, generationId: generation.id, noteIds: [...selectedNoteIds]});
      setMessage('state' in receipt && receipt.state === 'nothing-missing'
        ? '所选笔记基础字段已齐全，未发起采集。'
        : '已提交所选基础缺项补取，请查看任务状态。');
    } catch {
      setMessage('本次操作未确认或受到来源限制，请先核对任务状态；不会自动重发。');
    } finally {
      await refresh().catch(() => setMessage('任务状态读取失败，请刷新核对；不会自动重发。'));
      lock.current = false; setBusy(false);
    }
  };
  const results = job.items.filter(item => item.mediaResult);
  return <div className="my-2 text-xs">
    {results.map(item => <p key={item.noteId}>{item.title || '未命名笔记'}：{item.mediaResult === 'complete' ? '图片已验证保存' : item.mediaResult === 'needs-detail-refresh' ? '图片地址失效或不可用，需受控刷新详情' : '图片清单缺失或待核对，需受控刷新详情'}</p>)}
    {selectedNoteIds.length > 0 && <>
      <p>已选 {selectedNoteIds.length} 篇。仅补本任务可处理的所选笔记；历史未知请求和来源限制不会自动重发。</p>
      {!basicEligible && !mediaEligible && <p role="status">所选笔记不在可续补范围，或任务、来源状态仍需核对。</p>}
      <label><input type="checkbox" checked={basicConfirmedKey === key} disabled={busy || !basicEligible} onChange={e => setBasicConfirmedKey(e.target.checked ? key : '')} />确认仅补所选笔记缺失的发布时间和互动数据。</label>
      <button disabled={busy || !basicEligible || basicConfirmedKey !== key} onClick={() => void runBasic()}>补所选基础缺项</button>
      <label><input type="checkbox" checked={confirmedKey === key} disabled={busy || !mediaEligible} onChange={e => setConfirmedKey(e.target.checked ? key : '')} />确认补缺所选笔记的图片。</label>
      <button disabled={busy || !mediaEligible || confirmedKey !== key} onClick={() => void run()}>补缺所选图片</button>
      {message && <p role="status">{message}</p>}
    </>}
  </div>;
}
