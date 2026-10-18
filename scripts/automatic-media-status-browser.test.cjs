'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  browser,
  withFixture,
  web,
  modulePath,
} = require('./offline-browser-fixture.cjs');

test(
  'actual media diagnostic polls local state and shows retry, exhaustion and paused downloads',
  { skip: !browser, timeout: 120000 },
  async () => {
    const stub = path.resolve('scripts/.automatic-media-query-fixture.ts');
    fs.writeFileSync(
      stub,
      `import {useQuery} from '@tanstack/react-query';export const trpc={feed:{cacheSyncStatus:{useQuery:(_input,options)=>useQuery({queryKey:['auto-media-status'],queryFn:()=>window.fixture.read(),...options})}}};`,
    );
    try {
      await withFixture(
        `
import React from 'react';import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import CacheSyncStatus from ${modulePath(path.join(web, 'src/pages/feeds/cache-sync-status.tsx'))};
const client=new QueryClient();let reads=0;
let snapshot={feeds:[{feedId:'A',state:'synced-cache'}],media:[{feedId:'A',pending:1,failed:0,unconfirmed:0,attempts:1,nextRetryAt:'2026-10-18T12:30:00Z'}]};
window.fixture={read:()=>{reads++;return Promise.resolve(snapshot)},reads:()=>reads,set:(extra)=>{snapshot={...snapshot,...extra}},seed:()=>client.setQueryData(['auto-media-status'],snapshot)};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><CacheSyncStatus feedId="A"/></QueryClientProvider>);
`,
        async ({ evaluate, pause }) => {
          assert.match(
            await evaluate('document.body.innerText'),
            /图片待补 1 篇.*已尝试 1\/4/,
          );
          const initial = await evaluate('window.fixture.reads()');
          await evaluate(`window.fixture.set({mediaPause:'disabled'})`);
          await pause(5400);
          assert(
            (await evaluate('window.fixture.reads()')) > initial,
            'local diagnostic must advance without user action',
          );
          assert.match(
            await evaluate('document.body.innerText'),
            /自动图片下载已关闭/,
          );
          await evaluate(
            `window.fixture.set({media:[{feedId:'A',pending:0,failed:1,unconfirmed:1,attempts:4,nextRetryAt:null,code:'MEDIA_RETRY_EXHAUSTED'}]});window.fixture.seed()`,
          );
          await pause(80);
          assert.match(
            await evaluate('document.body.innerText'),
            /图片补齐失败 1 篇.*MEDIA_RETRY_EXHAUSTED.*媒体未确认 1 篇/,
          );
          await evaluate(
            `window.fixture.set({mediaFailure:'IMAGE_REQUEST_BLOCKED'});window.fixture.seed()`,
          );
          await pause(80);
          assert.match(
            await evaluate('document.body.innerText'),
            /图片补齐暂停.*IMAGE_REQUEST_BLOCKED/,
          );
          assert.equal(
            await evaluate(
              'document.querySelectorAll("p[role=status]").length',
            ),
            1,
          );
        },
        { '@web/utils/trpc': stub },
      );
    } finally {
      fs.unlinkSync(stub);
    }
  },
);
