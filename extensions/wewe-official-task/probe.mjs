/** Single read-only acceptance probe, not a collection or recovery action.
 * Run only if the controlling tool explicitly permits this page-backed scope.
 * A tool denial is terminal; no CDP, reset or alternate access mechanism.
 * Output is existence/matches/counts/fingerprints, never content/IDs/secrets.
 */
export async function probeOfficialArticle() {
  const roots = document.querySelectorAll('.wr_mp_reader');
  if (
    location.origin !== 'https://weread.qq.com' ||
    !/^\/web\/mp\/reader\/[A-Za-z0-9_-]{1,256}$/.test(location.pathname) ||
    roots.length !== 1
  )
    return { supported: false, rootCount: roots.length };
  const reader = roots[0].__vue__;
  if (reader?.$options?.name !== 'MpReader')
    return { supported: false, componentMatched: false };
  const frames = roots[0].querySelectorAll('iframe.mp_i_frame[srcdoc]');
  if (frames.length !== 1)
    return {
      supported: false,
      componentMatched: true,
      frameCount: frames.length,
    };
  const frame = frames[0];
  const doc = frame.contentDocument;
  if (!doc) return { supported: false, frameReadable: false };
  const bookId = reader.bookInfo?.bookId;
  const chapter = reader.currentChapter;
  const review = chapter?.review;
  const info = review?.mpInfo;
  const normalize = (value) =>
    typeof value === 'string'
      ? value.normalize('NFKC').replace(/\s+/gu, '')
      : '';
  const title = normalize(info?.title);
  const domTitle = normalize(doc.querySelector('#activity-name')?.textContent);
  const publisher = normalize(info?.mp_name);
  const domPublisher = normalize(doc.querySelector('#js_name')?.textContent);
  const fingerprint = async (source) => {
    const bodies = source.querySelectorAll('#js_content');
    if (bodies.length !== 1) return null;
    const body = bodies[0].cloneNode(true);
    body
      .querySelectorAll(
        'script,style,iframe,object,embed,form,input,button,link,meta,svg,base',
      )
      .forEach((node) => node.remove());
    const text = normalize(body.textContent);
    const images = body.querySelectorAll('img').length;
    const bytes = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify({ text, images })),
      ),
    );
    return {
      sha256: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''),
      textLength: text.length,
      images,
    };
  };
  const raw = reader.mpRawData;
  const rawBody =
    typeof raw === 'string' && raw.length <= 15_000_000
      ? await fingerprint(new DOMParser().parseFromString(raw, 'text/html'))
      : null;
  const domBody = await fingerprint(doc);
  const scalar = (name) => {
    const values = [
      ...frame.srcdoc.matchAll(
        new RegExp(
          '\\bvar\\s+' + name + '\\s*=\\s*(["\'])([^"\']*)\\1\\s*;',
          'g',
        ),
      ),
    ].map((m) => m[2]);
    return new Set(values).size === 1 ? values[0] : null;
  };
  let decodedBiz = '';
  try {
    decodedBiz = atob(scalar('biz') || '');
  } catch {}
  const images = [...doc.querySelectorAll('#js_content img')];
  const imageKinds = { data: 0, blob: 0, exactCdn: 0, other: 0, notLoaded: 0 };
  for (const image of images) {
    const source = image.currentSrc || image.getAttribute('src') || '';
    if (source.startsWith('data:image/')) imageKinds.data++;
    else if (source.startsWith('blob:https://weread.qq.com/'))
      imageKinds.blob++;
    else {
      try {
        const url = new URL(source);
        if (
          url.origin === 'https://mmbiz.qpic.cn' &&
          !url.username &&
          !url.password
        )
          imageKinds.exactCdn++;
        else imageKinds.other++;
      } catch {
        imageKinds.other++;
      }
    }
    if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1)
      imageKinds.notLoaded++;
  }
  return {
    supported: true,
    componentMatched: true,
    frameReadable: true,
    bookIdPresent: /^MP_WXS_\d{5,15}$/.test(bookId || ''),
    reviewIdPresent: typeof chapter?.reviewId === 'string',
    originalIdPresent: /^[A-Za-z0-9_~-]{22}$/.test(info?.originalId || ''),
    reviewBindingMatched:
      chapter?.reviewId === review?.reviewId &&
      chapter?.reviewId === bookId + '_' + info?.originalId,
    publisherBindingMatched:
      review?.belongBookId === bookId && bookId === 'MP_WXS_' + decodedBiz,
    titleMatched: !!title && !!domTitle && title === domTitle,
    publisherMatched:
      !!publisher && !!domPublisher && publisher === domPublisher,
    creationTimePresent: /^\d{10}$/.test(
      scalar('ct') || scalar('create_time') || '',
    ),
    identityScalarsPresent: !!(scalar('biz') && scalar('mid') && scalar('idx')),
    canonicalPresent: !!doc
      .querySelector('meta[property="og:url"]')
      ?.getAttribute('content'),
    notLoading: reader.showLoading === false,
    notError: reader.showError === false,
    notForbidden: reader.isBookForbidden === false,
    rawBody,
    domBody,
    bodyProjectionMatched: !!rawBody && rawBody.sha256 === domBody?.sha256,
    imageKinds,
  };
}
