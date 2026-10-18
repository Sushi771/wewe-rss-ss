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
  'actual reading status: quiet history, brief observed success, retained skips/failures and on-demand storage details',
  { skip: !browser, timeout: 90000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-reading-status-'));
    const shim = path.join(root, 'trpc.ts');
    fs.writeFileSync(
      shim,
      `window.__mutations=[];const mutation=()=>({mutateAsync:async(input)=>{window.__mutations.push(input)}});export const trpc={feed:{stopSubscriptionBatch:{useMutation:mutation},resumeSubscriptionBatch:{useMutation:mutation}}};`,
    );
    const warning =
      '备份空间接近容量或按持续变化预测剩余不足24小时，请尽快复核恢复点并安排归档。已有恢复点不会自动删除。';
    let report = { status: 'ready', writesAllowed: true, message: warning },
      apiError = false,
      requests = 0;
    const batch = {
      batchId: 'fixture-round',
      state: 'completed',
      updatedAt: Date.parse('2026-10-17T01:00:00Z'),
      items: Array.from({ length: 14 }, (_, index) => ({
        index,
        state: 'succeeded',
        accepted: true,
        message: '',
      })),
      coverage: {
        expected: 14,
        submitted: 14,
        completed: 14,
        pending: 0,
        legitimateSkipped: 0,
        excluded: 0,
        anomalies: 0,
        fullyUpdated: true,
        items: [],
      },
    };
    const source = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route,useNavigate} from 'react-router-dom';
import Startup from ${modulePath(path.join(web, 'src/components/StartupAuditNotice.tsx'))};import Storage from ${modulePath(path.join(web, 'src/pages/tools/storage-status.tsx'))};import Progress from ${modulePath(path.join(web, 'src/pages/feeds/manual-refresh-progress.tsx'))};
const initial=${JSON.stringify(batch)};function App(){const [batch,setBatch]=useState(initial),[key,setKey]=useState(0);const navigate=useNavigate();window.fixture={setBatch,initial,remount:()=>setKey(k=>k+1),navigate,mutations:()=>window.__mutations};return <><Startup key={key}/><Routes><Route path='/feeds' element={<Progress batch={batch} feeds={[]} onChange={async()=>{}}/>}/><Route path='/tools/article-download' element={<div style={{height:'80vh',overflowY:'auto'}}><Storage/></div>}/></Routes></>};createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/feeds']}><App/></MemoryRouter>);`;
    await withFixture(
      source,
      async ({ evaluate, pause, send }) => {
        const until = async (read, message) => {
          for (let i = 0; i < 120; i++) {
            if (await read()) return;
            await pause(50);
          }
          assert.fail(message);
        };
        await until(() => requests > 0, 'startup read');
        await pause(100);
        assert.equal(
          await evaluate(
            `document.body.innerText.includes(${JSON.stringify(warning)})`,
          ),
          false,
        );
        assert.equal(
          await evaluate("document.body.innerText.includes('本轮应更新')"),
          false,
        );
        assert.equal(
          await evaluate("document.body.innerText.includes('上次更新成功')"),
          true,
        );
        assert.equal(
          await evaluate(
            "Boolean(document.querySelector('[role=progressbar]'))",
          ),
          false,
        );
        await send('Page.reload');
        await until(
          () =>
            evaluate(
              "Boolean(window.fixture)&&document.body.innerText.includes('上次更新成功')",
            ),
          'quiet reload',
        );
        assert.equal(
          await evaluate(
            "document.querySelector('summary').textContent.includes('本轮全部更新完成')",
          ),
          false,
        );
        await evaluate(
          "window.fixture.setBatch({...window.fixture.initial,state:'running'})",
        );
        await until(
          () =>
            evaluate("Boolean(document.querySelector('[role=progressbar]'))"),
          'running progress',
        );
        await evaluate('window.fixture.setBatch({...window.fixture.initial})');
        await until(
          () =>
            evaluate(
              "document.querySelector('summary').textContent==='本轮全部更新完成。'",
            ),
          'brief successful transition',
        );
        assert.equal(
          await evaluate(
            "Boolean(document.querySelector('[role=progressbar]'))",
          ),
          false,
        );
        assert.equal(
          await evaluate("document.body.innerText.includes('本轮应更新')"),
          false,
        );
        await pause(5200);
        assert.equal(
          await evaluate(
            "document.querySelector('summary').textContent.includes('上次更新成功')",
          ),
          true,
        );
        await evaluate('window.fixture.setBatch({...window.fixture.initial})');
        await pause(100);
        assert.equal(
          await evaluate(
            "document.querySelector('summary').textContent.includes('上次更新成功')",
          ),
          true,
        );
        await evaluate("document.querySelector('summary').click()");
        assert.equal(
          await evaluate("document.body.innerText.includes('本轮应更新 14')"),
          true,
        );
        await evaluate(
          "window.fixture.setBatch({...window.fixture.initial,batchId:'skip',coverage:{...window.fixture.initial.coverage,completed:13,submitted:13,legitimateSkipped:1,excluded:1},items:window.fixture.initial.items.map((x,i)=>i===13?{...x,state:'skipped'}:x)})",
        );
        await until(
          () =>
            evaluate("Boolean(document.querySelector('[role=progressbar]'))"),
          'skips do not claim all success',
        );
        assert.equal(
          await evaluate("document.body.innerText.includes('上次更新成功')"),
          false,
        );
        await evaluate(
          "window.fixture.setBatch({...window.fixture.initial,state:'paused',coverage:{...window.fixture.initial.coverage,fullyUpdated:false,completed:13,anomalies:1},items:window.fixture.initial.items.map((x,i)=>i===13?{...x,state:'blocked'}:x)})",
        );
        await until(
          () =>
            evaluate("document.body.innerText.includes('部分更新需要处理')"),
          'failure reminder remains',
        );
        assert.deepEqual(await evaluate('window.fixture.mutations()'), []);
        report = {
          status: 'failed',
          writesAllowed: false,
          message: '备份空间预算不足，请核对恢复点后处理。',
        };
        await evaluate('window.fixture.remount()');
        await until(
          () =>
            evaluate(
              "document.body.innerText.includes('存储空间受限，更新和修改已暂停。')",
            ),
          'true blocking notice',
        );
        assert.equal(
          await evaluate(
            "document.body.innerText.includes('请核对恢复点后处理')",
          ),
          false,
        );
        await evaluate(
          "Array.from(document.querySelectorAll('a')).find(x=>x.textContent==='查看详情').click()",
        );
        await until(
          () =>
            evaluate(
              "Boolean(document.querySelector('#storage-backup[open]'))&&document.body.innerText.includes('请核对恢复点后处理')",
            ),
          'details route opens and reads',
        );
        await until(
          () =>
            evaluate(
              "(()=>{const e=document.querySelector('#storage-backup');const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return r.top>=Math.max(0,p.top)-1&&r.bottom<=Math.min(innerHeight,p.bottom)+1})()",
            ),
          'details link reveals the loaded card within its scroll container and viewport',
        );
        apiError = true;
        await evaluate(
          "document.querySelector('#storage-backup button').click()",
        );
        await until(
          () =>
            evaluate(
              "document.body.innerText.includes('状态读取失败，请重试。')",
            ),
          'details failures stay visible',
        );
      },
      {
        'react-router-dom': path.join(web, 'node_modules/react-router-dom'),
        '@web/utils/trpc': shim,
        '@web': path.join(web, 'src'),
      },
      {
        handleRequest(req, res) {
          if (req.url !== '/startup-status') return false;
          requests++;
          res.statusCode = apiError ? 503 : 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(report));
          return true;
        },
      },
    );
  },
);
