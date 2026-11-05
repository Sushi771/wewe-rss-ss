'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  browser,
  withFixture,
  web,
  modulePath,
} = require('./offline-browser-fixture.cjs');

test(
  'progress disclosure stays operable and keeps user choice through polling and completion',
  { skip: !browser, timeout: 90000 },
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wewe-progress-toggle-'),
    );
    const shim = path.join(root, 'trpc.ts');
    fs.writeFileSync(
      shim,
      `window.mutations=[];const mutation=name=>({useMutation:()=>({mutateAsync:async input=>window.mutations.push({name,input})})});export const trpc={feed:{stopSubscriptionBatch:mutation('stop'),resumeSubscriptionBatch:mutation('resume')}};`,
    );
    const initial = {
      batchId: 'synthetic-round',
      state: 'running',
      updatedAt: Date.now(),
      items: Array.from({ length: 13 }, (_, index) => ({
        index,
        state: 'waiting',
        accepted: true,
        message: '',
      })),
      coverage: {
        expected: 13,
        submitted: 13,
        completed: 0,
        pending: 13,
        legitimateSkipped: 0,
        excluded: 0,
        anomalies: 0,
        fullyUpdated: false,
        items: [],
      },
    };
    const source = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Progress from ${modulePath(path.join(web, 'src/pages/feeds/manual-refresh-progress.tsx'))};import ${modulePath(path.join(web, 'src/index.css'))};function App(){const [batch,setBatch]=useState(${JSON.stringify(initial)});window.fixture={setBatch};return <Progress batch={batch} feeds={[]} onChange={async()=>{}}/>}createRoot(document.getElementById('root')).render(<App/>);`;
    try {
      await withFixture(
        source,
        async ({ evaluate, pause, send }) => {
          const open = () => evaluate("document.querySelector('details').open");
          const click = async () => {
            await evaluate("document.querySelector('summary').click()");
            await pause(60);
          };
          assert.equal(await open(), false);
          await click();
          assert.equal(await open(), true);
          assert.equal(
            await evaluate("document.querySelector('summary').textContent"),
            '收起逐号进度',
          );
          assert.equal(
            await evaluate(
              "document.querySelector('details > div').clientHeight <= 256",
            ),
            true,
          );
          assert.equal(
            await evaluate(
              "document.querySelector('summary').getBoundingClientRect().top >= 0",
            ),
            true,
          );
          await click();
          assert.equal(await open(), false);
          await click();
          assert.equal(await open(), true);
          await evaluate("window.fixture.setBatch(b=>({...b,state:'paused'}))");
          await pause(60);
          await click();
          assert.equal(await open(), false);
          for (const state of ['paused', 'running', 'paused']) {
            await evaluate(
              `window.fixture.setBatch(b=>({...b,state:${JSON.stringify(state)},updatedAt:Date.now(),items:b.items.map(i=>({...i}))}))`,
            );
            await pause(60);
            assert.equal(await open(), false, 'a poll must not undo collapse');
          }
          await click();
          assert.equal(await open(), true);
          await evaluate(
            "window.fixture.setBatch(b=>({...b,state:'running'}))",
          );
          await pause(60);
          await evaluate(
            "window.fixture.setBatch(b=>({...b,state:'completed',items:b.items.map(i=>({...i,state:'succeeded'})),coverage:{...b.coverage,completed:13,pending:0,fullyUpdated:true}}))",
          );
          await pause(100);
          assert.equal(
            await open(),
            true,
            'completion retains the open choice',
          );
          await click();
          assert.equal(await open(), false);
          await click();
          assert.equal(await open(), true);
          assert.deepEqual(
            await evaluate('window.mutations'),
            [],
            'disclosure never stops or resumes work',
          );
          await evaluate(
            "window.fixture.setBatch(b=>({...b,batchId:'new-round',state:'running',coverage:{...b.coverage,completed:0,pending:13,fullyUpdated:false}}))",
          );
          await pause(60);
          assert.equal(await open(), false, 'a new batch gets a fresh default');
          await evaluate(
            "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('停止剩余更新')).click()",
          );
          await pause(60);
          assert.deepEqual(await evaluate('window.mutations'), [
            { name: 'stop', input: { batchId: 'new-round' } },
          ]);
          if (process.env.PROGRESS_TOGGLE_SCREENSHOT) {
            await click();
            const screenshot = await send('Page.captureScreenshot', {
              format: 'png',
            });
            fs.writeFileSync(
              process.env.PROGRESS_TOGGLE_SCREENSHOT,
              Buffer.from(screenshot.data, 'base64'),
            );
          }
        },
        { '@web/utils/trpc': shim, '@web': path.join(web, 'src') },
        { productionStyles: true },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
