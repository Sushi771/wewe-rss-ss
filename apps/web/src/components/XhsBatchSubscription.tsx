import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from './AppOverlays';
import {
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
} from '@nextui-org/react';
import {
  batchCodeMessage,
  batchItemLabels,
  batchStateLabels,
  batchStorageKeys,
  previewBatchText,
  validBatch,
} from '@web/utils/xhs-subscription-batch';
import type {
  BatchApi,
  SubscriptionBatch,
} from '@web/utils/xhs-subscription-batch';
const stored = (key: string) => {
  try {
    return sessionStorage.getItem(key) || '';
  } catch {
    return '';
  }
};
const remember = (key: string, value: string) => {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* In-memory operation remains available. */
  }
};
export default function XhsBatchSubscription({
  open,
  onClose,
  api,
  groups,
  budget,
  onSubscribed,
}: {
  open: boolean;
  onClose: () => void;
  api: BatchApi;
  groups: Array<{ id: string; name: string }>;
  budget: ReactNode;
  onSubscribed: () => void;
}) {
  const [text, setText] = useState(''),
    [groupId, setGroupId] = useState(() =>
      stored(batchStorageKeys.pendingGroup),
    );
  const [batch, setBatch] = useState<SubscriptionBatch | null>(null),
    [batchId, setBatchId] = useState(() => stored(batchStorageKeys.id));
  const [pendingId, setPendingId] = useState(() =>
    stored(batchStorageKeys.pending),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [readVersion, setReadVersion] = useState(0);
  const intro = useRef<HTMLParagraphElement>(null);
  const operation = useRef(false),
    alive = useRef(true),
    generation = useRef(0),
    openRef = useRef(open),
    notified = useRef(new Set<string>()),
    clientId = useRef(pendingId);
  openRef.current = open;
  const preview = previewBatchText(text);
  const receive = (next: SubscriptionBatch) => {
    if (!validBatch(next)) throw Error('invalid receipt');
    remember(batchStorageKeys.id, next.batchId);
    setBatchId(next.batchId);
    setBatch(next);
    for (const item of next.items)
      if (
        item.state === 'subscribed' &&
        !notified.current.has(item.fingerprint)
      ) {
        notified.current.add(item.fingerprint);
        onSubscribed();
      }
  };
  const receiveRef = useRef(receive);
  receiveRef.current = receive;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const version = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    if (open) {
      const saved = stored(batchStorageKeys.id);
      if (saved && saved !== batchId) setBatchId(saved);
    }
    if (!open || !batchId) return;
    const read = async () => {
      try {
        const next = await api.subscriptionBatch.query({ batchId });
        if (stopped || !alive.current || generation.current !== version) return;
        if (next.batchId !== batchId || !validBatch(next))
          throw Error('wrong receipt');
        receiveRef.current(next);
        setError('');
        if (
          next.state === 'queued' ||
          next.state === 'running' ||
          next.items.some((item) => item.state === 'resolving')
        )
          timer = setTimeout(() => void read(), 2000);
      } catch {
        if (!stopped && alive.current && generation.current === version)
          setError('本地回执暂时无法读取，请点击重新读取；不会重新提交。');
      }
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, batchId, readVersion, api]);
  const perform = async (kind: 'start' | 'resume' | 'cancel') => {
    if (operation.current) return;
    operation.current = true;
    // Keep keyboard events in the dialog before disabling the focused action.
    intro.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
    setBusy(true);
    setError('');
    const version = ++generation.current;
    const submitted = text;
    try {
      let next: SubscriptionBatch;
      if (kind === 'start') {
        if (!clientId.current) {
          clientId.current = crypto.randomUUID();
          remember(batchStorageKeys.pending, clientId.current);
          remember(batchStorageKeys.pendingGroup, groupId);
          setPendingId(clientId.current);
        }
        next = await api.startSubscriptionBatch.mutate({
          clientRequestId: clientId.current,
          text: submitted,
          ...(groupId ? { groupId } : {}),
        });
      } else if (kind === 'resume')
        next = await api.resumeSubscriptionBatch.mutate({
          batchId,
          text: submitted,
        });
      else next = await api.cancelSubscriptionBatch.mutate({ batchId });
      if (!validBatch(next) || (kind !== 'start' && next.batchId !== batchId))
        throw Error('invalid receipt');
      remember(batchStorageKeys.id, next.batchId);
      if (kind === 'start') {
        remember(batchStorageKeys.pending, '');
        remember(batchStorageKeys.pendingGroup, '');
        clientId.current = '';
      }
      if (!alive.current || !openRef.current || generation.current !== version)
        return;
      setPendingId('');
      receiveRef.current(next);
      setReadVersion((v) => v + 1);
    } catch {
      if (alive.current && openRef.current && generation.current === version)
        setError(
          kind === 'start'
            ? '提交回执未确认。请保留原输入，使用同一提交编号核对，勿新建重复批次。'
            : '操作回执未确认，请先重新读取本地回执；不会自动重试。',
        );
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const unknown =
    batch?.items.some((item) => item.state === 'unknown') ?? false;
  const settling =
    batch?.items.some((item) => item.state === 'resolving') ?? false;
  const active =
    batch?.state === 'queued' || batch?.state === 'running' || settling;
  const canResume =
    (batch?.state === 'paused' || batch?.state === 'cancelled') &&
    !unknown &&
    !settling &&
    batch.items.some((item) =>
      ['queued', 'needs_context'].includes(item.state),
    );
  const close = () => {
    generation.current++;
    setText('');
    onClose();
  };
  const fresh = () => {
    if (active || unknown || operation.current) return;
    setBatch(null);
    setBatchId('');
    setPendingId('');
    clientId.current = '';
    setText('');
    setError('');
    remember(batchStorageKeys.id, '');
    remember(batchStorageKeys.pending, '');
    remember(batchStorageKeys.pendingGroup, '');
  };
  return (
    <Modal isOpen={open} onClose={close} size="2xl">
      <ModalContent>
        <ModalHeader>批量订阅小红书博主</ModalHeader>
        <ModalBody>
          <p ref={intro} className="text-sm">
            每行粘贴链接，或直接粘贴整段分享文案。按博主去重后依次订阅；不会自动采集笔记或评论。
          </p>
          <label className="grid gap-2 text-sm">
            {batch ? '继续处理所需的原始分享内容' : '链接或分享文案'}
            <textarea
              aria-label="批量订阅内容"
              className="min-h-32 w-full rounded border bg-transparent p-2"
              rows={5}
              value={text}
              disabled={busy || active}
              onChange={(e) => setText(e.target.value)}
              placeholder="粘贴一条或多条小红书链接、分享文案…"
            />
          </label>
          <p role="status" className="text-xs">
            初步识别 {preview.detected} 条链接，完全相同重复{' '}
            {preview.duplicates} 条，官方候选 {preview.official}{' '}
            条。按博主去重以处理回执为准。
          </p>
          {(preview.detected > 100 || text.length > 65536) && (
            <p role="alert">
              一次最多接受 100 条候选链接，分享文本最多 65536 字符，请减少输入。
            </p>
          )}
          {!batch && (
            <label className="grid gap-2 text-sm">
              订阅文件夹
              <select
                aria-label="批量订阅文件夹"
                disabled={busy || !!pendingId}
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className="rounded border bg-transparent p-2"
              >
                <option value="">未分组</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {budget}
          {pendingId && !batch && (
            <p role="status" className="text-sm">
              上次提交结果尚未确认。重新粘贴原始内容后核对回执，会复用原提交编号。
            </p>
          )}
          {batch && (
            <section aria-label="批量订阅回执" className="grid gap-2 text-sm">
              {batch.state === 'cancelled' && settling && (
                <p role="status">
                  取消已记录，正在等待当前项回执；暂不开始新批次。
                </p>
              )}
              <p role="status">
                {batchStateLabels[batch.state]} · 成功{' '}
                {batch.items.filter((i) => i.state === 'subscribed').length} ·
                重复博主{' '}
                {batch.items.filter((i) => i.state === 'duplicate').length} ·
                未完成{' '}
                {
                  batch.items.filter(
                    (i) => !['subscribed', 'duplicate'].includes(i.state),
                  ).length
                }
              </p>
              <p className="break-all text-xs text-neutral-500">
                批次编号：{batch.batchId}
              </p>
              {batch.state === 'paused' && (
                <p role="status">
                  已暂停。请核对额度、请求间隔与来源状态，确认后再明确继续。
                </p>
              )}
              {unknown && (
                <p role="alert">
                  有已派发但结果未确认的项，暂不允许再次派发，请先核对回执。
                </p>
              )}
              <ol className="space-y-2" aria-label="逐项订阅结果">
                {batch.items.map((item) => (
                  <li
                    key={`${item.index}:${item.fingerprint}`}
                    className="rounded border p-2"
                  >
                    <span>
                      第 {item.index + 1} 项 · {batchItemLabels[item.state]}
                    </span>
                    {item.code &&
                      !['subscribed', 'duplicate'].includes(item.state) && (
                        <p className="mt-1 text-xs text-neutral-500">
                          {batchCodeMessage(item.code)}
                        </p>
                      )}
                  </li>
                ))}
              </ol>
              <p className="text-xs text-neutral-500">
                恢复时需重新粘贴原始链接；成功和重复项不会重做。关闭窗口只停止查看，取消需要明确点击。
              </p>
            </section>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </ModalBody>
        <ModalFooter className="flex-wrap">
          <Button variant="light" onPress={close}>
            关闭
          </Button>
          {batchId && (
            <Button
              variant="light"
              isDisabled={busy}
              onPress={() => setReadVersion((v) => v + 1)}
            >
              重新读取回执
            </Button>
          )}
          {batch && ['queued', 'running', 'paused'].includes(batch.state) && (
            <Button
              variant="flat"
              isDisabled={busy}
              onPress={() => void perform('cancel')}
            >
              取消批次
            </Button>
          )}
          {canResume && (
            <Button
              color="primary"
              isDisabled={
                busy ||
                !text.trim() ||
                preview.detected > 100 ||
                text.length > 65536
              }
              onPress={() => void perform('resume')}
            >
              继续未完成项
            </Button>
          )}
          {!batch && (
            <Button
              color="primary"
              isDisabled={
                busy ||
                !!batchId ||
                !text.trim() ||
                preview.detected > 100 ||
                text.length > 65536
              }
              onPress={() => void perform('start')}
            >
              {busy ? '正在提交…' : pendingId ? '核对提交回执' : '开始批量订阅'}
            </Button>
          )}
          {batch &&
            ['completed', 'cancelled'].includes(batch.state) &&
            !unknown &&
            !settling && (
              <Button variant="light" isDisabled={busy} onPress={fresh}>
                开始新批次
              </Button>
            )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
