// One offline deliverable: overview, full approved documents and isolated demo.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const folder = path.join(
  repo,
  'output/subscription-implementation/challenge-20261005',
);
const prototype = fs.readFileSync(
  path.join(folder, 'WeWe-跨端交互原型.html'),
  'utf8',
);
let html = fs.readFileSync(
  path.join(repo, 'docs/paid-sources/REVIEW.html'),
  'utf8',
);
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const documents = [
  [
    '../PAID_MULTIPLATFORM_PLAN.md',
    'docs/PAID_MULTIPLATFORM_PLAN.md',
    '文档总览',
  ],
  [
    'PRODUCT_REQUIREMENTS.md',
    'docs/paid-sources/PRODUCT_REQUIREMENTS.md',
    '产品需求与验收',
  ],
  [
    'FRONTEND_INTERACTIONS.md',
    'docs/paid-sources/FRONTEND_INTERACTIONS.md',
    '前端交互',
  ],
  [
    'BACKEND_CONTRACT.md',
    'docs/paid-sources/BACKEND_CONTRACT.md',
    '后端与接口契约',
  ],
  [
    'TECHNICAL_DEPLOYMENT.md',
    'docs/paid-sources/TECHNICAL_DEPLOYMENT.md',
    '技术与部署',
  ],
  [
    'DEVELOPMENT_PLAN.md',
    'docs/paid-sources/DEVELOPMENT_PLAN.md',
    '开发任务与排期',
  ],
  [
    'CURRENT_UPDATES.md',
    'docs/paid-sources/CURRENT_UPDATES.md',
    '本轮更新与剩余事项',
  ],
];
let embedded =
  '<section id="full-documents" style="max-width:1100px;margin:30px auto;padding:20px"><h2>完整文档 · 展开阅读</h2>';
documents.forEach(([link, filename, title], index) => {
  const id = `full-document-${index}`;
  html = html.replaceAll(`href="${link}"`, `href="#${id}"`);
  embedded += `<details id="${id}"><summary>${title}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:14px;line-height:1.8;padding:16px">${escape(fs.readFileSync(path.join(repo, filename), 'utf8'))}</pre></details>`;
});
embedded +=
  '</section><section id="interactive-prototype"><h2 style="text-align:center">交互原型 · 仅本地虚构示例</h2><div id="root"></div></section>';
const styles = [...prototype.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
  (match) => match[1],
);
const scripts = [
  ...prototype.matchAll(/<script type="module">([\s\S]*?)<\/script>/g),
].map((match) => match[1]);
if (!styles.length || scripts.length !== 1)
  throw new Error('PROTOTYPE_BUNDLE_MISSING');
html = html.replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/g,
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'\" />",
);
html = html.replace(
  '</head>',
  () => `<style>${styles.join('\n')}</style></head>`,
);
html = html.replace(
  '</body>',
  () => `${embedded}<script type="module">${scripts[0]}</script></body>`,
);
if (/<script\b[^>]*src=|<link\b[^>]*(?:href|rel)=|<iframe\b/i.test(html))
  throw new Error('EXTERNAL_ASSET_OR_FRAME');
const packagedScripts = [
  ...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g),
];
if (packagedScripts.length !== 1)
  throw new Error('INLINE_SCRIPT_COUNT_INVALID');
const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], {
  input: packagedScripts[0][1],
  encoding: 'utf8',
});
if (syntax.error || syntax.status !== 0)
  throw new Error('INLINE_SCRIPT_SYNTAX_INVALID');
const filename = path.join(folder, 'WeWe订阅开发计划.html');
fs.writeFileSync(filename, html);
const bytes = fs.readFileSync(filename);
const manifest = {
  filename,
  bytes: bytes.length,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  fullDocuments: documents.length,
  prototype: 'synthetic-memory-only',
  connectSrc: 'none',
  browserVisualAcceptance: false,
};
fs.writeFileSync(
  path.join(folder, 'PAID_FINAL_REVIEW_HTML.private.json'),
  JSON.stringify(manifest, null, 2),
);
console.log(JSON.stringify(manifest));
