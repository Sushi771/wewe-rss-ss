import {
  failureMessage,
  operationDiagnostic,
} from '../utils/operation-message';
import type { ReactNode } from 'react';

/** Keep the actionable result visible and the original diagnostic available. */
export default function OperationNotice({
  message,
  children,
}: {
  message: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-1 text-sm">
      <p>{message}</p>
      {children && (
        <details className="break-words">
          <summary className="cursor-pointer">查看详情</summary>
          <div className="mt-1 whitespace-pre-wrap">{children}</div>
        </details>
      )}
    </div>
  );
}

export function FailureNotice({
  error,
  fallback,
}: {
  error: unknown;
  fallback?: string;
}) {
  const raw = operationDiagnostic(error);
  return (
    <OperationNotice message={failureMessage(error, fallback)}>
      {raw}
    </OperationNotice>
  );
}
