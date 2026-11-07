import type { MemorySessionInput } from './xhs-memory-connection';

type Host = {
  origin: string;
  privateMode: boolean;
  authCode: () => string | null;
  send: typeof fetch;
};
/** Never use a query cache for secret-bearing responses. */
export async function savedSessionRequest(
  host: Host,
  input?: MemorySessionInput & { replaceSaved: boolean; autoRestore: boolean },
  signal?: AbortSignal,
): Promise<MemorySessionInput | null> {
  let body = '';
  try {
    const origin = new URL(host.origin);
    if (
      host.privateMode ||
      !['http:', 'https:'].includes(origin.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.origin !== host.origin
    )
      throw new Error('unavailable');
    if (
      input &&
      [input.a1, input.webSession].some(
        (value) =>
          !value ||
          value.length > 8192 ||
          /[;\s]/.test(value) ||
          Array.from(value).some((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f;
          }),
      )
    )
      throw new Error('invalid');
    const auth = host.authCode();
    if (input) body = JSON.stringify({ ...input, persist: true });
    const pending = host.send(
      new URL(
        input
          ? '/trpc/xiaohongshu.connectSession'
          : '/trpc/xiaohongshu.savedSession',
        origin,
      ),
      {
        method: input ? 'POST' : 'GET',
        headers: {
          ...(input ? { 'content-type': 'application/json' } : {}),
          ...(auth ? { authorization: auth } : {}),
        },
        ...(input ? { body } : {}),
        mode: 'same-origin',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: signal ?? AbortSignal.timeout(15000),
      },
    );
    body = '';
    if (input) {
      input.a1 = '';
      input.webSession = '';
    }
    const response = await pending;
    if (!response.ok) throw new Error('rejected');
    const envelope = await response.json();
    const data = envelope?.result?.data;
    if (input) {
      if (data?.connected !== true) throw new Error('unconfirmed');
      return null;
    }
    if (typeof data?.a1 !== 'string' || typeof data?.webSession !== 'string')
      throw new Error('unavailable');
    const result = { a1: data.a1, webSession: data.webSession };
    data.a1 = '';
    data.webSession = '';
    return result;
  } finally {
    body = '';
    if (input) {
      input.a1 = '';
      input.webSession = '';
    }
  }
}

export type SavedSessionStatus = {
  sessionPresent: boolean;
  autoRestore: boolean;
  needsReconnect: boolean;
  restoreFailed: boolean;
};
/** Only safe booleans survive this request; no savedSession read occurs. */
export async function savedSessionStatus(
  host: Host,
  signal?: AbortSignal,
): Promise<SavedSessionStatus> {
  const origin = new URL(host.origin);
  if (
    host.privateMode ||
    !['http:', 'https:'].includes(origin.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
    origin.origin !== host.origin
  )
    throw new Error('unavailable');
  const auth = host.authCode();
  const response = await host.send(
    new URL('/trpc/xiaohongshu.connectionStatus', origin),
    {
      method: 'GET',
      headers: auth ? { authorization: auth } : {},
      mode: 'same-origin',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: signal ?? AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error('rejected');
  const data = (await response.json())?.result?.data;
  if (!data || typeof data.sessionPresent !== 'boolean')
    throw new Error('unconfirmed');
  return {
    sessionPresent: data.sessionPresent,
    autoRestore: data.persistence?.autoRestore === true,
    needsReconnect: data.persistence?.needsReconnect === true,
    restoreFailed: data.persistence?.restoreFailed === true,
  };
}
