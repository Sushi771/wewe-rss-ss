import { useRef, useState } from 'react';

type Preview = {
  state: 'reviewable' | 'cancelled';
  batchId: string;
  digest: string;
  position: number;
  creatorId: string;
  operationId: string;
  cancelledCount: number;
};
export default function XhsBatchLocalCancellation({
  batchId,
  disabled,
  creatorNames,
  prepare,
  confirm,
  onBusyChange,
}: {
  batchId: string;
  disabled: boolean;
  creatorNames: Record<string, string>;
  prepare: (batchId: string) => Promise<Preview>;
  confirm: (input: {
    batchId: string;
    digest: string;
    acknowledgedNotDispatched: true;
  }) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const begin = () => {
    if (active.current || disabled) return false;
    active.current = true;
    setPending(true);
    onBusyChange(true);
    return true;
  };
  const end = () => {
    active.current = false;
    setPending(false);
    onBusyChange(false);
  };
  return (
    <details className="w-full rounded border p-2 text-xs">
      <summary>核查并取消未发送的旧批次</summary>
      <p className="my-2">
        只核查旧任务是否在准备阶段停止且未发送请求。确认后取消整个旧批次，保留旧任务与历史未知记录，不开始新采集。
      </p>
      <button
        type="button"
        disabled={disabled || pending}
        className="rounded border px-2 py-1 disabled:opacity-50"
        onClick={async () => {
          if (!begin()) return;
          setPreview(undefined);
          setChecked(false);
          setMessage('');
          try {
            const result = await prepare(batchId);
            if (result.batchId !== batchId) throw new Error('scope changed');
            if (result.state === 'cancelled')
              setMessage('该旧批次已完成本地取消，请重新读取批次状态。');
            else setPreview(result);
          } catch {
            setMessage(
              '当前证据不足、来源受限或状态已变化，保护仍保留。没有发送请求。',
            );
          } finally {
            end();
          }
        }}
      >
        核查本地记录
      </button>
      {preview && (
        <div className="mt-2 space-y-2">
          <p>
            已核对：
            {creatorNames[preview.creatorId] ||
              `第 ${preview.position + 1} 个账号`}
            的旧任务在准备阶段未发送。将取消旧批次的 {preview.cancelledCount}{' '}
            项，不重试原任务。
          </p>
          <label className="block">
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled || pending}
              onChange={(e) => setChecked(e.target.checked)}
            />{' '}
            我已核对范围，同意仅取消这个旧批次并保留历史记录。
          </label>
          <button
            type="button"
            disabled={!checked || disabled || pending}
            className="rounded border px-2 py-1 disabled:opacity-50"
            onClick={async () => {
              if (!checked || !begin()) return;
              setChecked(false);
              setMessage('');
              try {
                await confirm({
                  batchId,
                  digest: preview.digest,
                  acknowledgedNotDispatched: true,
                });
                setPreview(undefined);
              } catch {
                setPreview(undefined);
                setMessage(
                  '取消回执未确认，请只读重新核查状态；不会自动重试或采集。',
                );
              } finally {
                end();
              }
            }}
          >
            确认取消旧批次（不发送请求）
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="mt-2">
          {message}
        </p>
      )}
    </details>
  );
}
