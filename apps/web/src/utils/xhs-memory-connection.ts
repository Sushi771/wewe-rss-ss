export type MemorySessionInput = { a1: string; webSession: string };
export type MemoryConnectionResult =
  | { status: 'connected'; sourceBlocked: boolean }
  | { status: 'invalid' | 'unavailable' | 'rejected' | 'unconfirmed' };

/** Direct local transport: session input never enters a query/mutation cache. */
export async function connectMemorySession(
  input: MemorySessionInput,
  host: {
    origin: string;
    privateMode: boolean;
    authCode: () => string | null;
    send: typeof fetch;
  },
): Promise<MemoryConnectionResult> {
  let body = '';
  try {
    const origin = new URL(host.origin);
    if (
      host.privateMode ||
      !['http:', 'https:'].includes(origin.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.origin !== host.origin
    )
      return { status: 'unavailable' };
    if (
      [input.a1, input.webSession].some(
        (value) =>
          !value ||
          value.length > 8192 ||
          /[;\s]/.test(value) ||
          Array.from(value).some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          }),
      )
    )
      return { status: 'invalid' };
    const authCode = host.authCode();
    body = JSON.stringify({
      a1: input.a1,
      webSession: input.webSession,
      persist: false,
    });
    input.a1 = '';
    input.webSession = '';
    const pending = host.send(
      new URL('/trpc/xiaohongshu.connectSession', origin),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authCode ? { authorization: authCode } : {}),
        },
        body,
        mode: 'same-origin',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(15000),
      },
    );
    body = '';
    const response = await pending;
    if (!response.ok) return { status: 'rejected' };
    const data = (await response.json())?.result?.data;
    return data?.connected === true
      ? { status: 'connected', sourceBlocked: !!data.riskCode }
      : { status: 'unconfirmed' };
  } catch {
    return { status: 'unconfirmed' };
  } finally {
    body = '';
    input.a1 = '';
    input.webSession = '';
  }
}
