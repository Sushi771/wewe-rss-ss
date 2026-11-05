/** Only fixed classifications and a validated numeric HTTP status cross layers. */
export class XhsMediaError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** A 200 response was received and failed local image validation. */
export class XhsMediaLocalResponseError extends XhsMediaError {}
export function mediaHttpError(status: number) {
  return new XhsMediaError(
    Number.isInteger(status) && status >= 100 && status <= 599
      ? `XHS_MEDIA_HTTP_${status}`
      : 'XHS_MEDIA_RESPONSE_INVALID',
  );
}
