/** Only inert template text is marked. Cached HTML and exports stay unchanged. */
export const READER_MATCH_LIMIT = 5000;
const excluded =
  'script,style,noscript,template,textarea,select,svg,math,[hidden],[aria-hidden="true"]';
const blocks =
  'p,div,section,article,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,figcaption';

export function markArticleText(
  doc: Document,
  contentHtml: string,
  keyword: string,
  prefix: string,
) {
  if (!keyword)
    return { html: contentHtml, ids: [] as string[], truncated: false };
  const template = doc.createElement('template');
  // Template content is inert: never append/import it into the host document.
  template.innerHTML = contentHtml;
  const groups: Text[][] = [];
  const walker = doc.createTreeWalker(template.content, 4 /* SHOW_TEXT */);
  let group: Text[] = [];
  let block: Element | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const parent = text.parentElement;
    if (parent?.closest(excluded)) continue;
    const nextBlock = parent?.closest(blocks) || null;
    if (block !== nextBlock && group.length) {
      groups.push(group);
      group = [];
    }
    block = nextBlock;
    group.push(text);
  }
  if (group.length) groups.push(group);
  const segments = new Map<
    Text,
    { start: number; end: number; id: string; first: boolean }[]
  >();
  const ids: string[] = [];
  let truncated = false;
  outer: for (const texts of groups) {
    const value = texts.map((text) => text.data).join('');
    let offset = 0;
    const ends = texts.map((text) => (offset += text.length));
    let position = 0;
    let startNode = 0;
    // Literal, case-sensitive, non-overlapping matches preserve UTF-16 offsets.
    while ((position = value.indexOf(keyword, position)) !== -1) {
      if (ids.length === READER_MATCH_LIMIT) {
        truncated = true;
        break outer;
      }
      while (ends[startNode] <= position) startNode++;
      const id = `${prefix}-${ids.length}`;
      ids.push(id);
      const end = position + keyword.length;
      for (let i = startNode; i < texts.length; i++) {
        const start = ends[i - 1] || 0;
        const list = segments.get(texts[i]) || [];
        list.push({
          start: Math.max(position - start, 0),
          end: Math.min(end - start, texts[i].length),
          id,
          first: i === startNode,
        });
        segments.set(texts[i], list);
        if (ends[i] >= end) break;
      }
      position = end;
    }
  }
  for (const [text, list] of segments) {
    const fragment = doc.createDocumentFragment();
    let offset = 0;
    for (const match of list) {
      fragment.append(doc.createTextNode(text.data.slice(offset, match.start)));
      const mark = doc.createElement('mark');
      mark.className = 'wewe-reader-match';
      if (match.first) mark.id = match.id;
      // User input never becomes HTML, attribute names, selectors, or regex.
      mark.textContent = text.data.slice(match.start, match.end);
      fragment.append(mark);
      offset = match.end;
    }
    fragment.append(doc.createTextNode(text.data.slice(offset)));
    text.replaceWith(fragment);
  }
  return { html: template.innerHTML, ids, truncated };
}

export function readerDocument(contentHtml: string, baseUrl: string) {
  const escapedBase = baseUrl
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
  // Blob fragments provide native no-script navigation while sandbox remains
  // empty. A trusted base preserves the original srcDoc relative image/link URLs.
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'"><base href="${escapedBase}"><style>body{font:17px/1.8 sans-serif;padding:16px;color:#222;overflow-wrap:anywhere}img{max-width:100%;height:auto}p{margin:1em 0}mark.wewe-reader-match{background:#ffe680;color:#222;scroll-margin-top:24px}mark.wewe-reader-match:target{background:#ff9800;color:#111;outline:2px solid #c55a00}</style></head><body>${contentHtml}</body></html>`;
}
