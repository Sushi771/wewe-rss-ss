import { captureOfficialArticle } from './capture.mjs';
import { projectOfficialArticle } from './projection.mjs';

const uuid = /^[a-f0-9-]{36}$/;
export function localEndpoint(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('LOCAL_ENDPOINT');
  return url.origin;
}

/** Called solely by the popup button, with ephemeral config. No background loop. */
export async function runTask({ chrome, fetch, base, key, taskId }) {
  base = localEndpoint(base);
  if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !uuid.test(taskId))
    throw new Error('PAIRING_INPUT');
  if (!(await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })))
    throw new Error('LOOPBACK_PERMISSION_PENDING');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const source = new URL(tab?.url || '');
  if (
    source.origin !== 'https://weread.qq.com' ||
    !/^\/web\/mp\/reader\/[A-Za-z0-9_-]{1,256}$/.test(source.pathname) ||
    !Number.isSafeInteger(tab.id) ||
    !Number.isSafeInteger(tab.windowId)
  )
    throw new Error('SOURCE_TAB');
  const binding = {
    tabId: tab.id,
    windowId: tab.windowId,
    pageUrl: source.origin + source.pathname,
  };
  const send = async (stage, data) => {
    const response = await fetch(base + '/browser-task/' + stage, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-WeWe-Pairing': key },
      body: JSON.stringify({ taskId, ...data }),
    });
    if (!response.ok) throw new Error('TASK_REJECTED');
    return response.json();
  };
  // Claim first: no page read without a matching server-created short-lived task.
  const claim = await send('claim', { binding });
  try {
    const project = async () => {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: projectOfficialArticle,
      });
      if (
        results.length !== 1 ||
        results[0].frameId !== 0 ||
        !results[0].result
      )
        throw new Error('PROJECTION_UNAVAILABLE');
      return results[0].result;
    };
    const projection = await project();
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: captureOfficialArticle,
    });
    const observation =
      results.length === 1 && results[0].frameId === 0
        ? results[0].result
        : null;
    if (!observation || observation.pageUrl !== binding.pageUrl)
      throw new Error('SOURCE_NAVIGATED');
    const current = await chrome.tabs.get(tab.id);
    if (
      current.windowId !== binding.windowId ||
      new URL(current.url).origin + new URL(current.url).pathname !==
        binding.pageUrl
    )
      throw new Error('SOURCE_NAVIGATED');
    const after = await project();
    if (JSON.stringify(after) !== JSON.stringify(projection))
      throw new Error('ARTICLE_CHANGED');
    observation.projection = projection;
    let total = 0;
    for (const image of observation.images) {
      if (!image.inline) {
        if (
          !(await chrome.permissions.contains({
            origins: ['https://mmbiz.qpic.cn/*'],
          }))
        )
          throw new Error('MEDIA_PERMISSION_PENDING');
        const url = new URL(image.source);
        if (
          url.origin !== 'https://mmbiz.qpic.cn' ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error('IMAGE_SOURCE');
        const response = await fetch(url.href, {
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        });
        const type = (response.headers.get('content-type') || '')
          .split(';')[0]
          .toLowerCase();
        if (
          response.status !== 200 ||
          !/^image\/(png|jpeg|gif|webp)$/.test(type) ||
          !response.body
        )
          throw new Error('IMAGE_BYTES');
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > 10_000_000 || total + length > 20_000_000)
              throw new Error('IMAGE_SIZE');
            chunks.push(value);
          }
        } catch (error) {
          await reader.cancel();
          throw error;
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        image.inline = 'data:' + type + ';base64,' + btoa(binary);
      }
      if (typeof image.inline !== 'string' || image.inline.length > 13_333_400)
        throw new Error('IMAGE_SIZE');
      total += Math.ceil(((image.inline.split(',')[1] || '').length * 3) / 4);
      if (total > 20_000_000) throw new Error('IMAGE_SIZE');
      delete image.source;
    }
    const finalTab = await chrome.tabs.get(tab.id);
    if (
      finalTab.windowId !== binding.windowId ||
      new URL(finalTab.url).origin + new URL(finalTab.url).pathname !==
        binding.pageUrl
    )
      throw new Error('SOURCE_NAVIGATED');
    if (JSON.stringify(await project()) !== JSON.stringify(projection))
      throw new Error('ARTICLE_CHANGED');
    const payload = { binding, nonce: claim.nonce, observation };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 35_000_000)
      throw new Error('PAYLOAD_SIZE');
    return await send('complete', payload);
  } catch (error) {
    // Fixed failure marker only; no HTML, URLs, tokens or page errors in logs.
    await send('cancel', { binding, nonce: claim.nonce }).catch(() => {});
    throw error;
  }
}
