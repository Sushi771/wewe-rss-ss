/** Narrow candidate adapter for the audited MpReader component. MAIN is needed
 * for Vue's displayed article fields. It is not an authentication bridge.
 * No store/global enumeration, dispatch, getters for auth, or credentials.
 * All returned fields remain untrusted and are checked again by the server.
 */
export async function projectOfficialArticle() {
  const fail = (code) => {
    throw new Error(code);
  };
  if (location.origin !== 'https://weread.qq.com') fail('SOURCE_ORIGIN');
  if (!/^\/web\/mp\/reader\/[A-Za-z0-9_-]{1,256}$/.test(location.pathname))
    fail('SOURCE_PATH');
  const roots = [...document.querySelectorAll('.wr_mp_reader')];
  if (roots.length !== 1) fail('READER_UNAVAILABLE');
  const reader = roots[0].__vue__;
  if (
    reader?.$options?.name !== 'MpReader' ||
    reader.showLoading ||
    reader.showError ||
    reader.isBookForbidden ||
    reader.isBookInfoError
  )
    fail('READER_NOT_READY');
  const bookId = reader.bookInfo?.bookId;
  if (typeof bookId !== 'string' || !/^MP_WXS_\d{5,15}$/.test(bookId))
    fail('BOOK_ID');
  const project = (entry) => {
    const review = entry?.review;
    const info = review?.mpInfo;
    if (!info) fail('REVIEW_SCHEMA');
    // Do not spread entry/review/info: unknown properties may contain secrets.
    return {
      reviewId: entry.reviewId,
      review: {
        reviewId: review.reviewId,
        belongBookId: review.belongBookId,
        bookId: review.bookId || '',
        type: review.type,
        mpInfo: {
          originalId: info.originalId,
          title: info.title,
          mp_name: info.mp_name,
          time: info.time,
          pic_url: typeof info.pic_url === 'string' ? info.pic_url : '',
        },
      },
    };
  };
  const current = project(reader.currentChapter);
  // mpRawData is the audited returned article business content, not a token.
  // Reduce it in place to a body fingerprint; never send scripts/raw state.
  const raw = reader.mpRawData;
  if (typeof raw !== 'string' || !raw || raw.length > 15_000_000)
    fail('RAW_BODY_UNAVAILABLE');
  const parsed = new DOMParser().parseFromString(raw, 'text/html');
  const bodies = parsed.querySelectorAll('#js_content');
  if (bodies.length !== 1) fail('RAW_BODY_UNAVAILABLE');
  const copy = bodies[0].cloneNode(true);
  copy
    .querySelectorAll(
      'script,style,iframe,object,embed,form,input,button,link,meta,svg,base',
    )
    .forEach((node) => node.remove());
  const fingerprintInput = JSON.stringify({
    text: copy.textContent.normalize('NFKC').replace(/\s+/gu, ''),
    images: copy.querySelectorAll('img').length,
  });
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(fingerprintInput),
    ),
  );
  const bodyFingerprint = [...bytes]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { bookId, current, bodyFingerprint };
}
