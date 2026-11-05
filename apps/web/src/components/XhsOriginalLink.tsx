import { useEffect, useRef, useState } from 'react';
import {
  originalLinkMessage,
  verifiedOriginalUrl,
} from '../utils/xhs-note-presentation';

export type PreparedXhsLink =
  | { state: 'ready'; url: string }
  | { state: 'not_ready'; code: string };
export type PrepareXhsLink = (input: {
  creatorId: string;
  noteId: string;
  refreshContext?: boolean;
}) => Promise<PreparedXhsLink>;

/** Explicit prepare, then an ordinary user-activated link avoids popup blockers. */
export default function XhsOriginalLink({
  creatorId,
  noteId,
  title,
  author,
  prepare,
  onConfigure,
}: {
  creatorId: string;
  noteId: string;
  title: string;
  author?: string;
  prepare: PrepareXhsLink;
  onConfigure?: (creatorId: string) => void;
}) {
  const [url, setUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [needsBudget, setNeedsBudget] = useState(false);
  const [errorMessage, setErrorMessage] = useState(originalLinkMessage());
  const current = useRef(0),
    pending = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const start = async (refreshContext = false) => {
    if (pending.current || !mounted.current) return;
    pending.current = true;
    const request = ++current.current;
    setBusy(true);
    setFailed(false);
    setNeedsBudget(false);
    setErrorMessage(originalLinkMessage());
    setUrl(undefined);
    try {
      const result = await prepare({
        creatorId,
        noteId,
        ...(refreshContext ? { refreshContext: true } : {}),
      });
      if (!mounted.current || request !== current.current) return;
      if (result.state !== 'ready') {
        setFailed(true);
        setNeedsBudget(
          [
            'XHS_REQUEST_BUDGET_REQUIRED',
            'XHS_REQUEST_BUDGET_EXHAUSTED',
            'XHS_BUDGET_SCOPE_MISMATCH',
          ].includes(result.code),
        );
        setErrorMessage(originalLinkMessage(result.code));
        return;
      }
      const verified = verifiedOriginalUrl(noteId, result.url);
      if (!verified) {
        setFailed(true);
        return;
      }
      setUrl(verified);
    } catch {
      if (mounted.current && request === current.current) setFailed(true);
    } finally {
      if (mounted.current && request === current.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <div className="xhs-note-origin">
      {url ? (
        <a
          className="compact-title xhs-note-title"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          aria-label={`打开原文 ${title}`}
          title={title}
        >
          <span className="xhs-note-title-text">{title}</span>
          <span className="xhs-note-origin-hint">打开原文 ↗</span>
        </a>
      ) : (
        <button
          type="button"
          className="compact-title xhs-note-title"
          aria-label={`准备原文 ${title}`}
          data-original-note-id={noteId}
          disabled={busy}
          onClick={() => void start(failed)}
          title="点击准备原文链接，成功后点击打开"
        >
          <span className="xhs-note-title-text">{title}</span>
          <span className="xhs-note-origin-hint">
            {busy ? '准备中…' : failed ? '重新准备原文' : '准备原文 ↗'}
          </span>
        </button>
      )}
      {url && (
        <button
          type="button"
          className="xhs-note-origin-refresh text-xs underline"
          aria-label={`重新准备原文 ${title}`}
          disabled={busy}
          onClick={() => void start(true)}
        >
          链接失效？重新准备
        </button>
      )}
      {author && <span className="xhs-note-author">{author}</span>}
      {failed && (
        <p role="alert" className="xhs-note-link-error">
          {errorMessage}
          {needsBudget && onConfigure && (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => onConfigure(creatorId)}
            >
              设置请求额度
            </button>
          )}
        </p>
      )}
    </div>
  );
}
