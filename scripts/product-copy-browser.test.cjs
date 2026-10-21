'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  browser,
  withFixture,
  web,
  modulePath,
} = require('./offline-browser-fixture.cjs');

test(
  'search and failure notices show actionable facts, expandable escaped diagnostics and working controls',
  { skip: !browser, timeout: 120000 },
  async () => {
    await withFixture(
      `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import ${modulePath(path.join(web, 'src/index.css'))};
import ArticleSearchStatus from ${modulePath(path.join(web, 'src/components/ArticleSearchStatus.tsx'))};
import {FailureNotice} from ${modulePath(path.join(web, 'src/components/OperationNotice.tsx'))};
function App(){const [data,setData]=useState({total:300,uncached:40,pending:20});const [preparing,setPreparing]=useState(true);const [error,setError]=useState('SQLITE_FULL <img src=x onerror=alert(1)>');
window.fixture={setData,setError,counts:{pause:0,continue:0}};
return <main><h1>文章搜索</h1><ArticleSearchStatus data={data} preparing={preparing} onPause={()=>{window.fixture.counts.pause++;setPreparing(false)}} onContinue={()=>{window.fixture.counts.continue++;setPreparing(true)}}/><section aria-label="操作结果"><FailureNotice error={error}/></section></main>}
createRoot(document.getElementById('root')).render(<App/>);`,
      async ({ evaluate, send, pause }) => {
        const text = () => evaluate('document.body.innerText');
        let visible = await text();
        assert.match(visible, /正在准备正文搜索/);
        assert.match(visible, /部分正文暂未纳入结果/);
        assert.match(visible, /未保存的正文无法搜索/);
        assert.match(visible, /存储空间不足/);
        assert(!visible.includes('SQLITE_FULL'));
        assert(!visible.includes('全部订阅共'));
        await evaluate(
          "Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='暂停准备').click()",
        );
        await pause(50);
        assert.match(await text(), /继续准备正文搜索/);
        await evaluate(
          "Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='继续准备正文搜索').click()",
        );
        await pause(50);
        assert.match(await text(), /正在准备正文搜索/);
        const evidence = process.env.UI_COPY_EVIDENCE_DIR;
        await evaluate(
          "document.head.insertAdjacentHTML('beforeend','<meta name=viewport content=\"width=device-width, initial-scale=1\">')",
        );
        for (const width of [1280, 390]) {
          await send('Emulation.setDeviceMetricsOverride', {
            width,
            height: 800,
            deviceScaleFactor: 1,
            mobile: width < 500,
          });
          await pause(50);
          assert(
            await evaluate(
              'document.documentElement.scrollWidth<=window.innerWidth+1',
            ),
            'no horizontal overflow',
          );
          if (evidence) {
            fs.mkdirSync(evidence, { recursive: true });
            const shot = await send('Page.captureScreenshot', {
              format: 'png',
            });
            fs.writeFileSync(
              path.join(evidence, `product-copy-${width}.png`),
              Buffer.from(shot.data, 'base64'),
            );
          }
        }
        await evaluate(
          "document.querySelectorAll('summary').forEach(x=>x.click())",
        );
        await pause(30);
        visible = await text();
        assert.match(visible, /全部订阅共 300 篇/);
        assert.match(visible, /SQLITE_FULL/);
        assert.equal(
          await evaluate('document.querySelectorAll("img").length'),
          0,
          'diagnostics remain escaped text',
        );
        for (const [raw, expected] of [
          ['UNAUTHORIZED 401', '登录已失效'],
          ['FORBIDDEN 403', '无权执行'],
          ['captcha required', '官方验证'],
          ['429', '过于频繁'],
        ]) {
          await evaluate(
            `document.querySelectorAll('details').forEach(x=>x.open=false);window.fixture.setError(${JSON.stringify(raw)})`,
          );
          await pause(30);
          assert((await text()).includes(expected));
        }
        await evaluate(
          'window.fixture.setData({total:300,uncached:40,pending:0})',
        );
        await pause(30);
        // An active last batch may still finish; scope must never claim all bodies exist.
        assert.match(await text(), /未保存的正文无法搜索/);
      },
      { '@nextui-org/react': path.join(web, 'node_modules/@nextui-org/react') },
      { productionStyles: true, cleanupOwnedFixture: true },
    );
  },
);
