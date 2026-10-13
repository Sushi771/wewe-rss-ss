'use strict';
// Actual stylesheet geometry in an isolated browser; no product/platform calls.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict'),
  { test } = require('node:test');
const css = fs.readFileSync('apps/web/src/index.css', 'utf8');
const chrome =
  process.env.LAYOUT_TEST_BROWSER ||
  [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => fs.existsSync(p));
for (const [width, height] of [
  [1280, 800],
  [1024, 500],
  [390, 844],
  [390, 500],
  [667, 375],
])
  test(
    `dialog stays above transformed sticky content, inside viewport ${width}x${height}`,
    { skip: !chrome },
    () => {
      const dir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'wewe-records-layout-'),
        ),
        file = path.join(dir, 'fixture.html');
      fs.writeFileSync(
        file,
        `<!doctype html><meta charset="utf-8"><style>${css}body{margin:0}.under{position:fixed;inset:0;transform:translateZ(0);isolation:isolate;z-index:200}.sticky{position:sticky;top:0;height:100px;background:red;z-index:100}.subscription-dialog{background:white}.subscription-dialog-header{height:56px;padding:16px}.subscription-dialog-footer{height:64px;padding:16px}.subscription-dialog-body{padding:12px}.subscription-dialog-backdrop{position:fixed;inset:0;background:#0005}.subscription-dialog-close{position:absolute;top:12px;right:12px}.subscription-task-row{height:30px}</style>
 <div class="under"><div class="sticky">Underlying article toolbar</div></div><div class="subscription-dialog-backdrop"></div><div class="subscription-dialog-overlay"><div id="dialog" class="subscription-dialog"><header id="header" class="subscription-dialog-header">Task records<button id="close" class="subscription-dialog-close">Close</button></header><div id="list" tabindex="0" class="subscription-dialog-body">${'<div class="subscription-task-row"><span class="subscription-task-name">Synthetic very long publisher name '.repeat(1)}${'LongName'.repeat(80)}</span><span class="subscription-task-state">Waiting</span></div>${'<div class="subscription-task-row">Synthetic task row</div>'.repeat(150)}</div><footer id="footer" class="subscription-dialog-footer"><button>Close records</button></footer></div></div>
 <script>(()=>{const dialog=document.getElementById('dialog'),list=document.getElementById('list'),header=document.getElementById('header'),footer=document.getElementById('footer'),close=document.getElementById('close');const before=header.getBoundingClientRect();list.focus();list.scrollTop=list.scrollHeight;const box=dialog.getBoundingClientRect(),h=header.getBoundingClientRect(),f=footer.getBoundingClientRect(),c=close.getBoundingClientRect();const top=document.elementFromPoint(h.left+20,h.top+20);const result={within:box.top>=0&&box.bottom<=innerHeight&&box.left>=0&&box.right<=innerWidth,headerFixed:Math.abs(before.top-h.top)<1,footerVisible:f.bottom<=innerHeight,closeVisible:c.top>=0&&c.bottom<=innerHeight,listScrollable:list.scrollTop>0,listHeight:list.clientHeight,aboveSticky:top===header||header.contains(top),focusOnList:document.activeElement===list,widthOverflow:document.documentElement.scrollWidth>innerWidth};document.body.innerHTML='<pre id="result">'+JSON.stringify(result)+'</pre>';})();</script>`,
      );
      const run = spawnSync(
        chrome,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-background-networking',
          '--no-first-run',
          `--user-data-dir=${path.join(dir, 'profile')}`,
          `--window-size=${width},${height}`,
          '--dump-dom',
          `file:///${file.replace(/\\/g, '/')}`,
        ],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(run.status, 0, run.error?.message || run.stderr);
      const match = [
        ...run.stdout.matchAll(/<pre id="result">(.*?)<\/pre>/g),
      ].find((match) => match[1].startsWith('{'));
      assert(match);
      const result = JSON.parse(match[1]);
      console.log({ width, height, result });
      for (const key of [
        'within',
        'headerFixed',
        'footerVisible',
        'closeVisible',
        'listScrollable',
        'aboveSticky',
        'focusOnList',
      ])
        assert.equal(result[key], true, key);
      assert(result.listHeight > 0);
      assert.equal(result.widthOverflow, false);
    },
  );
