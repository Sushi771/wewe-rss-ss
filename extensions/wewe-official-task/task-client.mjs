import { captureOfficialArticle } from './capture.mjs';
import { projectOfficialArticle } from './projection.mjs';

const uuid = /^[a-f0-9-]{36}$/;
export function localEndpoint(raw) {
  if (typeof raw !== 'string' || !/^http:\/\/127\.0\.0\.1:4000\/?$/.test(raw))
    throw new Error('LOCAL_ENDPOINT');
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '4000' ||
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
const consumed = new WeakSet();
const checkpoint = (signal) => {
  if (signal?.aborted) throw new Error('TASK_CANCELLED');
};
const transportSignal = (signal) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
    : AbortSignal.timeout(10000);
const fresh = (prepared) => {
  checkpoint(prepared.signal);
  if (prepared.cancelled) throw new Error('TASK_CANCELLED');
  if (Date.now() >= Date.parse(prepared.claim.expiresAt))
    throw new Error('TASK_EXPIRED');
};

/** Claim transports task association only; no body read or CDN request. */
export async function prepareTask({
  chrome,
  fetch,
  base,
  key,
  taskId,
  signal,
}) {
  base = localEndpoint(base);
  if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !uuid.test(taskId))
    throw new Error('PAIRING_INPUT');
  if (!(await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })))
    throw new Error('LOOPBACK_PERMISSION_PENDING');
  checkpoint(signal);
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
  checkpoint(signal);
  const send = async (stage, data, ignoreCancellation = false) => {
    if (!ignoreCancellation) checkpoint(signal);
    const response = await fetch(base + '/browser-task/' + stage, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: transportSignal(ignoreCancellation ? undefined : signal),
      headers: { 'Content-Type': 'application/json', 'X-WeWe-Pairing': key },
      body: JSON.stringify({ taskId, ...data }),
    });
    if (!response.ok) throw new Error('TASK_REJECTED');
    return response.json();
  };
  // Claim first: no page read without a matching server-created short-lived task.
  const claim = await send('claim', { binding });
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(claim.nonce || '') ||
    !Number.isFinite(Date.parse(claim.expiresAt))
  )
    throw new Error('CLAIM_SCHEMA');
  const prepared = {
    base,
    key,
    taskId,
    binding,
    claim,
    send,
    signal,
    tab,
    cancelled: false,
  };
  try {
    fresh(prepared);
  } catch (error) {
    await cancelPreparedTask(prepared);
    throw error;
  }
  return prepared;
}

export async function cancelPreparedTask(prepared) {
  if (!prepared) return false;
  if (prepared.cancelPromise) return prepared.cancelPromise;
  prepared.cancelled = true;
  consumed.add(prepared);
  prepared.cancelPromise = (async () => {
    try {
      await prepared.send(
        'cancel',
        { binding: prepared.binding, nonce: prepared.claim.nonce },
        true,
      );
      return true;
    } catch {
      return false;
    }
  })();
  return prepared.cancelPromise;
}

export function taskDisclosure(prepared) {
  const claim = prepared.claim,
    d = claim.disclosure;
  if (
    claim.contentMode !== 'confirmed-dom' ||
    !d ||
    typeof d.title !== 'string' ||
    !d.title.trim() ||
    d.title.length > 1000 ||
    typeof d.publisher !== 'string' ||
    !d.publisher.trim() ||
    d.publisher.length > 1000 ||
    typeof d.destination !== 'string' ||
    !d.destination ||
    d.destination.length > 4096 ||
    !Number.isSafeInteger(d.imageCount) ||
    d.imageCount !== claim.confirmedImageCount ||
    d.imageCount < 0 ||
    d.imageCount > 60 ||
    !Number.isSafeInteger(d.publishTime)
  )
    throw new Error('DISCLOSURE_REQUIRED');
  const url = new URL(d.originalUrl);
  if (
    url.origin !== 'https://mp.weixin.qq.com' ||
    url.pathname !== '/s' ||
    url.username ||
    url.password
  )
    throw new Error('DISCLOSURE_REQUIRED');
  return {
    title: d.title,
    publisher: d.publisher,
    originalUrl: d.originalUrl,
    publishTime: d.publishTime,
    imageCount: d.imageCount,
    destination: d.destination,
  };
}

export async function runTask({
  chrome,
  fetch,
  base,
  key,
  taskId,
  prepared,
  signal,
}) {
  prepared ||= await prepareTask({ chrome, fetch, base, key, taskId, signal });
  if (consumed.has(prepared)) throw new Error('TASK_CONSUMED');
  consumed.add(prepared);
  const { claim, binding, tab, send } = prepared;
  signal = prepared.signal;
  try {
    fresh(prepared);
    const manual = claim.contentMode === 'confirmed-dom';
    if (claim.contentMode !== undefined && !manual)
      throw new Error('CONTENT_MODE');
    if (
      manual &&
      (!Number.isSafeInteger(claim.confirmedImageCount) ||
        claim.confirmedImageCount < 0 ||
        claim.confirmedImageCount > 60)
    )
      throw new Error('MANUAL_SCOPE');
    const disclosure = manual ? taskDisclosure(prepared) : undefined;
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
    const projection = manual ? null : await project();
    fresh(prepared);
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: captureOfficialArticle,
      ...(manual
        ? {
            args: [
              {
                confirmedImageCount: claim.confirmedImageCount,
                expectedArticle: disclosure,
              },
            ],
          }
        : {}),
    });
    const observation =
      results.length === 1 && results[0].frameId === 0
        ? results[0].result
        : null;
    fresh(prepared);
    if (!observation || observation.pageUrl !== binding.pageUrl)
      throw new Error('SOURCE_NAVIGATED');
    const current = await chrome.tabs.get(tab.id);
    fresh(prepared);
    if (
      current.windowId !== binding.windowId ||
      new URL(current.url).origin + new URL(current.url).pathname !==
        binding.pageUrl
    )
      throw new Error('SOURCE_NAVIGATED');
    const after = manual ? null : await project();
    if (!manual && JSON.stringify(after) !== JSON.stringify(projection))
      throw new Error('ARTICLE_CHANGED');
    if (!manual) observation.projection = projection;
    let total = 0;
    for (const image of observation.images) {
      fresh(prepared);
      if (!image.inline) {
        if (
          !(await chrome.permissions.contains({
            origins: ['https://mmbiz.qpic.cn/*'],
          }))
        )
          throw new Error('MEDIA_PERMISSION_PENDING');
        fresh(prepared);
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
          signal: transportSignal(signal),
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
            fresh(prepared);
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
    fresh(prepared);
    if (
      finalTab.windowId !== binding.windowId ||
      new URL(finalTab.url).origin + new URL(finalTab.url).pathname !==
        binding.pageUrl
    )
      throw new Error('SOURCE_NAVIGATED');
    if (manual) {
      const check = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: captureOfficialArticle,
        args: [
          {
            candidateOnly: true,
            confirmedImageCount: claim.confirmedImageCount,
            expectedArticle: disclosure,
          },
        ],
      });
      const final =
        check.length === 1 && check[0].frameId === 0 ? check[0].result : null;
      if (
        !final ||
        final.pageUrl !== observation.pageUrl ||
        final.html !== observation.html ||
        final.omittedEmptyImageNodes !== observation.omittedEmptyImageNodes ||
        !/^[a-f0-9]{64}$/.test(observation.assetFingerprint || '') ||
        final.assetFingerprint !== observation.assetFingerprint
      )
        throw new Error('ARTICLE_CHANGED');
      delete observation.assetFingerprint;
    } else if (JSON.stringify(await project()) !== JSON.stringify(projection))
      throw new Error('ARTICLE_CHANGED');
    const payload = { binding, nonce: claim.nonce, observation };
    fresh(prepared);
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 35_000_000)
      throw new Error('PAYLOAD_SIZE');
    const received = await send('complete', payload);
    fresh(prepared);
    if (received.accepted !== true) throw new Error('TASK_REJECTED');
    return received;
  } catch (error) {
    // Fixed failure marker only; no HTML, URLs, tokens or page errors in logs.
    await cancelPreparedTask(prepared);
    throw error;
  }
}
