/** Serializable ISOLATED-world function. No page JS execution, globals, storage,
 * credentials, navigation, clicking, captcha handlers or network interception.
 * Returns a reduced observation, never a verified ProviderArticle.
 */
export async function captureOfficialArticle({
  candidateOnly = false,
  confirmedImageCount,
  expectedArticle,
} = {}) {
  const fail = (code) => {
    throw new Error(code);
  };
  if (location.origin !== 'https://weread.qq.com') fail('SOURCE_ORIGIN');
  if (!/^\/web\/mp\/reader\/[A-Za-z0-9_-]{1,256}$/.test(location.pathname))
    fail('SOURCE_PATH');
  if (
    confirmedImageCount === undefined &&
    document.querySelector('.mpContentLoading, .mpContentError')
  )
    fail('PAGE_NOT_READY');
  const frames = [...document.querySelectorAll('iframe.mp_i_frame[srcdoc]')];
  if (frames.length !== 1) fail('ARTICLE_FRAME_AMBIGUOUS');
  const frame = frames[0];
  const doc = frame.contentDocument;
  if (!doc || !frame.srcdoc || frame.srcdoc.length > 15_000_000)
    fail('FRAME_UNREADABLE');
  if (
    doc.querySelector(
      '#js_verify,#verify,.weui_msg,form,input[type=password],iframe,video,audio',
    )
  )
    fail('UNSUPPORTED_OR_CHALLENGE');
  const bodies = [...doc.querySelectorAll('#js_content')];
  if (bodies.length !== 1) fail('BODY_MISSING');
  const body = bodies[0];
  if (!body.textContent.trim() && !body.querySelector('img'))
    fail('BODY_MISSING');
  const allImages = [...body.querySelectorAll('img')];
  if (allImages.length > 60) fail('IMAGE_COUNT');
  if (
    confirmedImageCount !== undefined &&
    (!Number.isSafeInteger(confirmedImageCount) ||
      confirmedImageCount < 0 ||
      confirmedImageCount > 60)
  )
    fail('MANUAL_CONFIRMATION_INVALID');
  // Only a server-bound manual confirmation can opt into ignoring nodes that
  // have no current/src/data-src asset at all. Hidden/lazy sourced images stay.
  const omitted =
    confirmedImageCount === undefined
      ? []
      : allImages
          .map((image, index) => ({ image, index }))
          .filter(
            ({ image }) =>
              !image.currentSrc &&
              !image.getAttribute('src') &&
              !image.getAttribute('data-src'),
          )
          .map(({ index }) => index);
  const images = allImages.filter((_image, index) => !omitted.includes(index));
  if (
    confirmedImageCount !== undefined &&
    images.length !== confirmedImageCount
  )
    fail('MANUAL_IMAGE_COVERAGE');
  // Read only reviewed static scalar assignments from srcdoc, never read/eval
  // the official app's Vue store, tokens, ticket, window globals or script code.
  const scalars = {};
  for (const [name, pattern] of Object.entries({
    biz: '[A-Za-z0-9+/=]+',
    mid: '[0-9]+',
    idx: '[0-9]+',
    sn: '[a-fA-F0-9]+',
    ct: '[0-9]{10}',
    create_time: '[0-9]{10}',
  })) {
    const values = [];
    const expression = new RegExp(
      '\\bvar\\s+' +
        name +
        '\\s*=\\s*(?:(["\'])(' +
        pattern +
        ')\\1' +
        (['mid', 'idx', 'ct', 'create_time'].includes(name)
          ? '|(' + pattern + ')'
          : '') +
        ')\\s*;',
      'g',
    );
    for (const match of frame.srcdoc.matchAll(expression))
      values.push(match[2] || match[3]);
    if (new Set(values).size > 1) fail('SCALAR_CONFLICT');
    if (values.length) scalars[name] = values[0];
  }
  if (scalars.ct && scalars.create_time && scalars.ct !== scalars.create_time)
    fail('SCALAR_CONFLICT');
  const title = doc.querySelector('#activity-name')?.textContent.trim();
  const publisher = doc.querySelector('#js_name')?.textContent.trim();
  const suppliedLinks = [...doc.querySelectorAll('meta[property="og:url"]')]
    .map((node) => node.getAttribute('content') || '')
    .filter(Boolean);
  const linkAssignments = [
    ...frame.srcdoc.matchAll(
      /\bvar\s+msg_link\s*=\s*(["'])([^"'\\\r\n]{0,4096})\1\s*;/g,
    ),
  ];
  if (
    (frame.srcdoc.match(/\bvar\s+msg_link\s*=/g) || []).length !==
    linkAssignments.length
  )
    fail('SOURCE_LINK_EXPRESSION');
  suppliedLinks.push(
    ...linkAssignments.map((match) => match[2]).filter(Boolean),
  );
  const linkSources = [];
  if (doc.querySelector('meta[property="og:url"]')?.getAttribute('content'))
    linkSources.push('og:url');
  if (linkAssignments.some((match) => match[2])) linkSources.push('msg_link');
  const decode = (value) =>
    new DOMParser()
      .parseFromString(
        '<span>' + value.replace(/</g, '&lt;') + '</span>',
        'text/html',
      )
      .querySelector('span')
      .textContent.trim();
  const links = suppliedLinks.map((raw) => {
    if (raw.length > 4096) fail('SOURCE_LINK_INVALID');
    let url;
    try {
      url = new URL(decode(raw));
    } catch {
      fail('SOURCE_LINK_INVALID');
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'mp.weixin.qq.com' ||
      url.port ||
      url.username ||
      url.password
    )
      fail('SOURCE_LINK_INVALID');
    if (url.pathname !== '/s') {
      if (
        !/^\/s\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname) ||
        url.search ||
        url.hash
      )
        fail('SOURCE_LINK_INVALID');
      return {
        provided: url.toString(),
        comparison: url.toString(),
        matched: false,
      };
    }
    for (const key of url.searchParams.keys())
      if (
        !['__biz', 'mid', 'idx', 'sn', 'chksm'].includes(key) ||
        url.searchParams.getAll(key).length !== 1
      )
        fail('SOURCE_LINK_INVALID');
    if (url.hash && url.hash !== '#rd') fail('SOURCE_LINK_INVALID');
    if (
      url.searchParams.has('sn') &&
      !/^[a-fA-F0-9]+$/.test(url.searchParams.get('sn'))
    )
      fail('SOURCE_LINK_INVALID');
    if (
      url.searchParams.has('chksm') &&
      !/^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get('chksm'))
    )
      fail('SOURCE_LINK_INVALID');
    let number;
    try {
      number = atob(url.searchParams.get('__biz') || '');
    } catch {
      fail('SOURCE_LINK_INVALID');
    }
    if (
      !/^\d{5,15}$/.test(number) ||
      !/^\d+$/.test(url.searchParams.get('mid') || '') ||
      !/^[1-9]\d*$/.test(url.searchParams.get('idx') || '')
    )
      fail('SOURCE_LINK_INVALID');
    for (const [scalar, key] of [
      ['biz', '__biz'],
      ['mid', 'mid'],
      ['idx', 'idx'],
      ['sn', 'sn'],
    ])
      if (scalars[scalar] && scalars[scalar] !== url.searchParams.get(key))
        fail('SOURCE_LINK_CONFLICT');
    // Comparison normalization only; the returned source remains page-supplied.
    const comparison = new URL('https://mp.weixin.qq.com/s');
    for (const key of ['__biz', 'mid', 'idx', 'sn'])
      if (url.searchParams.has(key))
        comparison.searchParams.set(key, url.searchParams.get(key));
    comparison.searchParams.sort();
    return {
      provided: url.toString(),
      comparison: comparison.toString(),
      matched: !!(scalars.biz && scalars.mid && scalars.idx),
    };
  });
  if (new Set(links.map((link) => link.comparison)).size > 1)
    fail('SOURCE_LINK_CONFLICT');
  const canonical = links[0]?.provided || '';
  if (
    !candidateOnly &&
    (!title ||
      !publisher ||
      !scalars.biz ||
      !scalars.mid ||
      !scalars.idx ||
      !(scalars.ct || scalars.create_time))
  )
    fail('IDENTITY_UNAVAILABLE');
  if (expectedArticle) {
    const expected = new URL(expectedArticle.originalUrl);
    expected.searchParams.delete('chksm');
    expected.hash = '';
    expected.searchParams.sort();
    const normalize = (value) =>
      value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (
      !links[0]?.matched ||
      links[0].comparison !== expected.toString() ||
      normalize(title || '') !== normalize(expectedArticle.title) ||
      normalize(publisher || '') !== normalize(expectedArticle.publisher) ||
      (scalars.ct || scalars.create_time) !==
        String(expectedArticle.publishTime)
    )
      fail('ARTICLE_CHANGED');
  }
  const copy = body.cloneNode(true);
  copy
    .querySelectorAll(
      'script,style,iframe,object,embed,form,input,button,link,meta,svg,base',
    )
    .forEach((node) => node.remove());
  const references = [];
  const allClonedImages = [...copy.querySelectorAll('img')];
  if (allClonedImages.length !== allImages.length) fail('IMAGE_STRUCTURE');
  for (const index of omitted) allClonedImages[index].remove();
  const clonedImages = allClonedImages.filter(
    (_image, index) => !omitted.includes(index),
  );
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    const source = image.currentSrc || image.getAttribute('src') || '';
    if (candidateOnly) {
      // DOM candidate mode never fetches even an existing Blob, copies inline
      // bytes, or requires Vue. References remain placeholders, not saved media.
      let kind = 'other';
      if (source.startsWith('data:image/')) kind = 'data';
      else if (source.startsWith('blob:https://weread.qq.com/')) kind = 'blob';
      else {
        try {
          const url = new URL(source);
          if (
            url.origin === 'https://mmbiz.qpic.cn' &&
            !url.username &&
            !url.password
          )
            kind = 'exactCdn';
        } catch {}
      }
      references.push({
        index,
        kind,
        loaded:
          !!image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
      });
      clonedImages[index].setAttribute('src', 'wewe-image:' + index);
      continue;
    }
    if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1)
      fail('IMAGE_NOT_LOADED');
    let inline = null;
    if (source.startsWith('data:')) inline = source;
    else if (source.startsWith('blob:https://weread.qq.com/')) {
      // Read the existing same-origin Blob only. No remote request or canvas
      // re-encoding; the server checks the actual bytes and image container.
      const response = await fetch(source, {
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      const type = (response.headers.get('content-type') || '').split(';')[0];
      if (
        !response.ok ||
        !response.body ||
        !/^image\/(png|jpeg|gif|webp)$/.test(type)
      )
        fail('IMAGE_BYTES');
      const stream = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await stream.read();
          if (done) break;
          length += value.length;
          if (length > 10_000_000) fail('IMAGE_BYTES');
          chunks.push(value);
        }
      } catch (error) {
        await stream.cancel();
        throw error;
      }
      const blob = new Blob(chunks, { type });
      inline = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('IMAGE_BYTES'));
        reader.readAsDataURL(blob);
      });
    } else {
      let url;
      try {
        url = new URL(source);
      } catch {
        fail('IMAGE_SOURCE');
      }
      if (
        url.origin !== 'https://mmbiz.qpic.cn' ||
        url.username ||
        url.password ||
        url.hash
      )
        fail('IMAGE_SOURCE');
    }
    references.push({ index, source: inline ? '' : source, inline });
    // Never return arbitrary src/href/srcset/CSS URLs for the server to fetch.
    clonedImages[index].setAttribute('src', 'wewe-image:' + index);
  }
  for (const node of [copy, ...copy.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      if (
        !['alt', 'title', 'colspan', 'rowspan'].includes(attribute.name) &&
        !(node.tagName === 'IMG' && attribute.name === 'src')
      )
        node.removeAttribute(attribute.name);
    }
  }
  copy.setAttribute('id', 'js_content');
  // Text fields are escaped as HTML; script scalars are strict character sets.
  const escape = (value) =>
    value.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  const metadata =
    '<script>' +
    Object.entries(scalars)
      .map(([name, value]) => 'var ' + name + '="' + value + '";')
      .join('') +
    '</script>';
  const html =
    (canonical
      ? '<meta property="og:url" content="' + escape(canonical) + '">'
      : '') +
    (title ? '<h1 id="activity-name">' + escape(title) + '</h1>' : '') +
    (publisher ? '<span id="js_name">' + escape(publisher) + '</span>' : '') +
    metadata +
    copy.outerHTML;
  if (new TextEncoder().encode(html).length > 5_000_000) fail('BODY_SIZE');
  let assetFingerprint;
  if (confirmedImageCount !== undefined) {
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        images.map(
          (image) =>
            image.currentSrc ||
            image.getAttribute('src') ||
            image.getAttribute('data-src') ||
            '',
        ),
      ),
    );
    assetFingerprint = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    ]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  }
  return {
    ...(candidateOnly
      ? {
          candidateOnly: true,
          verification: {
            articleIdentity: 'unverified',
            reviewBinding: 'unavailable',
            upstreamCompleteness: 'unproved',
            imageBytes: 'unverified',
          },
          fieldsPresent: {
            title: !!title,
            publisher: !!publisher,
            biz: !!scalars.biz,
            mid: !!scalars.mid,
            idx: !!scalars.idx,
            publishTime: !!(scalars.ct || scalars.create_time),
            canonical: !!canonical,
          },
          sourceLink: {
            status: links[0]?.matched
              ? 'static_identity_matched'
              : canonical
                ? 'unverified'
                : 'missing',
            sources: linkSources,
          },
          completeness: { status: 'unproved', imageRoles: 'unclassified' },
        }
      : {}),
    pageUrl: location.origin + location.pathname,
    html,
    images: references,
    ...(confirmedImageCount !== undefined
      ? { omittedEmptyImageNodes: omitted.length, assetFingerprint }
      : {}),
  };
}
