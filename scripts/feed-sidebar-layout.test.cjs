'use strict';
// Offline Chromium geometry check: actual stylesheet, long synthetic lists,
// isolated browser profile, no app/server/platform requests or user session.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'apps/web/src/index.css'), 'utf8');
const feeds = fs.readFileSync(
  path.join(root, 'apps/web/src/pages/feeds/index.tsx'),
  'utf8',
);
const chrome =
  process.env.LAYOUT_TEST_BROWSER ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => fs.existsSync(p));

test('subscription scroll owner has no clipped fixed-height nested list', () => {
  assert.match(feeds, /className="feed-workspace"/);
  assert.match(feeds, /mac-sidebar feed-sidebar/);
  assert.match(feeds, /feed-article-scroll/);
  assert(!feeds.includes('100vh-148px'));
  assert(!feeds.includes('flex-1 overflow-hidden px-0'));
  assert(!feeds.includes('px-0 pb-0 pt-1'));
  assert.match(feeds, /collectionChannels=\{Object\.fromEntries/);
  assert.match(feeds, /application\/x-wewe-wechat/);
  assert.match(feeds, /onDragEnd=\{isManageMode \? handleDragEnd/);
});

for (const [width, height, folderCount, open] of [
  [1280, 800, 3, true],
  [1024, 600, 30, true],
  [390, 844, 3, true],
  [390, 844, 30, true],
  [667, 375, 3, true],
  [390, 844, 3, false],
]) {
  test(
    `offline scroll geometry ${width}x${height}, folders=${folderCount}, open=${open}`,
    { skip: !chrome },
    () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wewe-sidebar-layout-'),
      );
      const html = path.join(directory, 'fixture.html');
      const folders = Array.from(
        { length: folderCount },
        (_, i) =>
          `<div class="folder-navigation-row"><button class="mac-sidebar-item folder-filter"><span class="folder-filter-label">Very long synthetic folder name ${i}</span></button><button>⋯</button></div>`,
      ).join('');
      const rows = Array.from(
        { length: 100 },
        (_, i) =>
          `<li class="mac-sidebar-item" ${i === 99 ? 'id="last-feed"' : ''}>Synthetic feed ${i}</li>`,
      ).join('');
      fs.writeFileSync(
        html,
        `<!doctype html><meta charset="utf-8"><style>${css}
      body{margin:0}ul{margin:0;padding:0;list-style:none}.mobile-controls{height:64px;flex-shrink:0}.fixture-toolbar{height:100px;flex-shrink:0}.feed-article-scroll{flex:1;overflow:auto}.fixture-article{height:60px}.feed-sidebar ul{padding-bottom:16px}.fixture-sidebar-heading{height:48px}@media(min-width:768px){.mobile-controls{display:none}}
      </style><main class="app-shell"><div style="height:48px"></div><div class="app-route"><div class="feed-workspace"><div class="mobile-controls"></div><div id="sidebar" class="mac-sidebar feed-sidebar ${open ? 'feed-sidebar-open' : ''}"><div class="fixture-sidebar-heading">Subscriptions / Manage</div><div class="folder-navigation"><div class="folder-navigation-header">Folders</div>${folders}</div><div><ul>${rows}</ul></div></div><div class="mac-content feed-content"><div class="fixture-toolbar">Article toolbar</div><div id="articles" class="feed-article-scroll">${'<div class="fixture-article">Synthetic article</div>'.repeat(100)}</div></div></div></div></main>
      <script>
      const side=document.getElementById('sidebar'),articles=document.getElementById('articles');
      const visible=getComputedStyle(side).display!=='none';
      const before=articles.scrollTop;side.scrollTop=side.scrollHeight;
      const end=document.getElementById('last-feed').getBoundingClientRect(),box=side.getBoundingClientRect();
      const sideOnly=articles.scrollTop===before;
      articles.scrollTop=200;
      articles.parentElement.scrollTop=articles.parentElement.scrollHeight;
      const result={visible,sideOnly,sideCanScroll:side.scrollTop>0,lastVisible:end.bottom<=box.bottom+1&&end.top>=box.top,articleCanScroll:articles.scrollTop===200,articleHeight:articles.clientHeight,bottom:articles.getBoundingClientRect().bottom,viewport:innerHeight,pageOverflow:document.documentElement.scrollHeight>innerHeight+1,widthOverflow:document.documentElement.scrollWidth>innerWidth+1};
      document.body.innerHTML='<pre id="result">'+JSON.stringify(result)+'</pre>';
      </script>`,
      );
      const run = spawnSync(
        chrome,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-background-networking',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${path.join(directory, 'profile')}`,
          `--window-size=${width},${height}`,
          '--dump-dom',
          `file:///${html.replace(/\\/g, '/')}`,
        ],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(run.status, 0, run.error?.message || run.stderr);
      const match = run.stdout.match(/<pre id="result">(.*?)<\/pre>/);
      assert(match, 'Chromium must return completed geometry evidence');
      const evidence = JSON.parse(match[1]);
      console.log({ width, height, folderCount, open, evidence });
      assert.equal(evidence.visible, width >= 768 || open);
      assert.equal(evidence.sideOnly, true);
      if (evidence.visible) {
        assert.equal(evidence.sideCanScroll, true);
        assert.equal(evidence.lastVisible, true);
      }
      assert.equal(evidence.articleCanScroll, true);
      assert(evidence.articleHeight > 0);
      assert(evidence.bottom <= evidence.viewport + 1);
      assert.equal(evidence.pageOverflow, false);
      assert.equal(evidence.widthOverflow, false);
    },
  );
}
