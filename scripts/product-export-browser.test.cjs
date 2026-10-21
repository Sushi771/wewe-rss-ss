'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const {
  browser,
  withFixture,
  web,
  modulePath,
} = require('./offline-browser-fixture.cjs');
const ts = require(require.resolve('typescript', { paths: [web] }));
function exportModal(source) {
  const ast = ts.createSourceFile(
    'page.tsx',
    source,
    99,
    true,
    ts.ScriptKind.TSX,
  );
  let found;
  function visit(n) {
    if (
      ts.isJsxElement(n) &&
      n.openingElement.tagName.getText(ast) === 'Modal' &&
      n.openingElement.attributes.getText(ast).includes('isOpen={exportOpen}')
    )
      found = n.getText(ast);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert(found);
  return found;
}
test(
  'actual export dialog is concise, preserves scope and format restrictions, and expands explanations',
  { skip: !browser, timeout: 180000 },
  async () => {
    for (const before of [true, false]) {
      const page = before
        ? cp.execFileSync(
            'git',
            [
              'show',
              '7bbdeef40019708c17f2f2aaed631ee78926d9a7:apps/web/src/pages/feeds/index.tsx',
            ],
            { encoding: 'utf8' },
          )
        : fs.readFileSync(path.join(web, 'src/pages/feeds/index.tsx'), 'utf8');
      await withFixture(
        `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {NextUIProvider,Modal,ModalHeader,ModalBody,ModalFooter,ModalContent,Button} from '@nextui-org/react';
import ArticleExportGuidance from ${modulePath(path.join(web, 'src/components/ArticleExportGuidance.tsx'))};import ${modulePath(path.join(web, 'src/index.css'))};
function App(){const [exportOpen,setExportOpen]=useState(true),[exportScope,setExportScope]=useState('selected'),[exportFormat,setExportFormat]=useState('obsidian');
const [id,setId]=useState(''),currentMpInfo={mpName:'示例公众号'},articleSelectedIds=new Set(Array.from({length:40},(_,i)=>String(i))),privateOnlineMode=false,dateError='',filteredExportSummary={data:{articles:1817}},allExportSummary={data:{articles:1817}},exportSummary={isFetching:false,isError:false,refetch:()=>{}},exportCount=exportScope==='selected'?40:1817,zipAvailable=Boolean(id)&&exportScope!=='selected',isBatchExporting=false,serverOriginUrl='',filteredZipQuery='',handleBatchExport=()=>{};
window.fixture={setId,setExportScope,setExportFormat};return <NextUIProvider>${exportModal(page)}</NextUIProvider>}
createRoot(document.getElementById('root')).render(<App/>);`,
        async ({ evaluate, send, pause }) => {
          for (
            let i = 0;
            i < 80 &&
            !(await evaluate(
              'Boolean(document.querySelector("[role=dialog]"))',
            ));
            i++
          )
            await pause(50);
          assert(
            await evaluate('Boolean(document.querySelector("[role=dialog]"))'),
          );
          await evaluate(
            "document.head.insertAdjacentHTML('beforeend','<meta name=viewport content=\"width=device-width, initial-scale=1\">')",
          );
          for (const width of [1280, 390]) {
            await send('Emulation.setDeviceMetricsOverride', {
              width,
              height: 900,
              deviceScaleFactor: 1,
              mobile: width < 500,
            });
            await pause(100);
            const visible = await evaluate('document.body.innerText');
            assert(visible.includes('40 篇'));
            assert(visible.includes('1817 篇'));
            assert(visible.includes('5000'));
            if (!before) {
              assert(!visible.includes('文章并发'));
              assert(!visible.includes('快照'));
              assert(!visible.includes('加载更多'));
              assert(visible.includes('仅导出已勾选的文章'));
              assert(!visible.includes('本次范围：'));
            }
            const dir = process.env.UI_COPY_EVIDENCE_DIR;
            if (dir) {
              fs.mkdirSync(dir, { recursive: true });
              const shot = await send('Page.captureScreenshot', {
                format: 'png',
              });
              fs.writeFileSync(
                path.join(
                  dir,
                  `export-${before ? 'before' : 'after'}-${width}.png`,
                ),
                Buffer.from(shot.data, 'base64'),
              );
            }
          }
          if (!before) {
            await evaluate('document.querySelector("summary").click()');
            await pause(50);
            assert(
              (await evaluate('document.body.innerText')).includes(
                '加载更多文章不会自动勾选',
              ),
            );
            await evaluate("window.fixture.setExportScope('all')");
            await pause(50);
            assert(
              (await evaluate('document.body.innerText')).includes(
                '所有订阅的全部文章，忽略当前筛选',
              ),
            );
            assert(
              await evaluate(
                'document.querySelector("option[value=zip]").disabled',
              ),
            );
            await evaluate("window.fixture.setId('synthetic-feed')");
            await pause(50);
            assert.equal(
              await evaluate(
                'document.querySelector("option[value=zip]").disabled',
              ),
              false,
            );
            await evaluate("window.fixture.setExportFormat('zip')");
            await pause(50);
            assert(
              (await evaluate('document.body.innerText')).includes(
                'ZIP 每次重新打包',
              ),
            );
          }
        },
        {
          '@nextui-org/react': path.join(web, 'node_modules/@nextui-org/react'),
        },
        { productionStyles: true, cleanupOwnedFixture: true },
      );
    }
  },
);
