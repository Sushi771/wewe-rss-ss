const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const vm = require('node:vm');
const web = createRequire(path.resolve('apps/web/package.json'));
const server = createRequire(path.resolve('apps/server/package.json'));
const ts = server('typescript');
const { createTRPCUntypedClient, httpBatchLink, httpLink, splitLink } =
  web('@trpc/client');
const { initTRPC } = server('@trpc/server');
const { createExpressMiddleware } = server('@trpc/server/adapters/express');
const express = server('express');
const baseline = require('./fixtures/reading-transport-baseline.json');
function predicate(mode) {
  const file = 'apps/web/src/provider/trpc.tsx';
  if (
    mode === 'baseline' &&
    process.env.READING_TRANSPORT_VERIFY_BASELINE !== '1'
  )
    return vm.runInNewContext(
      ts.transpile(`(${baseline.condition})`, {
        module: ts.ModuleKind.CommonJS,
      }),
    );
  const source =
    mode === 'baseline'
      ? execFileSync('git', ['show', `${baseline.source}:${file}`], {
          encoding: 'utf8',
        })
      : fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let value;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'splitLink'
    )
      value = node.arguments[0].properties
        .find((p) => p.name?.getText(ast) === 'condition')
        .initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert(value, 'actual provider split condition exists');
  if (mode === 'baseline')
    assert.equal(
      value.replace(/\s/g, ''),
      baseline.condition.replace(/\s/g, ''),
    );
  return vm.runInNewContext(
    ts.transpile(`(${value})`, { module: ts.ModuleKind.CommonJS }),
  );
}
test(
  'actual reading transport is independent of a held background batch, with auth/error/abort retained',
  { timeout: 30000 },
  async () => {
    const trpc = initTRPC.create();
    const protectedRead = trpc.procedure.use(({ ctx, next }) => {
      if (!ctx.authorized)
        throw new (server('@trpc/server').TRPCError)({ code: 'UNAUTHORIZED' });
      return next();
    });
    let release,
      entered,
      bodyRelease,
      bodyEntered,
      holdBody = false;
    const router = trpc.router({
      article: trpc.router({
        list: protectedRead.query(() => ({ items: [], nextCursor: null })),
        summary: protectedRead.query(() => ({ articles: 20 })),
        byId: protectedRead.query(async () => {
          if (holdBody) {
            bodyEntered?.();
            await new Promise((done) => {
              bodyRelease = done;
            });
          }
          return { id: 'synthetic', contentHtml: '<p>Saved body</p>' };
        }),
      }),
      background: trpc.router({
        wait: protectedRead.query(async () => {
          entered?.();
          await new Promise((done) => {
            release = done;
          });
          return { done: true };
        }),
      }),
    });
    const requests = [];
    const app = express();
    app.use(
      '/trpc',
      (req, res, next) => {
        requests.push(req.url.split('?')[0]);
        next();
      },
      createExpressMiddleware({
        router,
        createContext: ({ req }) => ({
          authorized: req.headers.authorization === 'synthetic',
        }),
      }),
    );
    const listener = await new Promise((done) => {
      const current = app.listen(0, '127.0.0.1', () => done(current));
    });
    const url = `http://127.0.0.1:${listener.address().port}/trpc`;
    const client = (condition, authorization = 'synthetic') =>
      createTRPCUntypedClient({
        links: [
          splitLink({
            condition,
            true: httpLink({ url, headers: { authorization } }),
            false: httpBatchLink({ url, headers: { authorization } }),
          }),
        ],
      });
    const samples = [];
    try {
      const modes =
        process.env.READING_TRANSPORT_EXPLORATION === '1'
          ? ['baseline']
          : ['baseline', 'current'];
      for (let round = 0; round < 5; round++)
        for (const mode of round % 2 ? [...modes].reverse() : modes) {
          const condition = predicate(mode),
            rpc = client(condition);
          const inFlight = new Promise((done) => {
            entered = done;
          });
          let bodyDone = false,
            summaryDone = false;
          const start = performance.now();
          const slow = rpc.query('background.wait');
          const body = rpc.query('article.byId').then((data) => {
            bodyDone = true;
            samples.push({
              round,
              mode,
              phase: 'byId',
              ms: performance.now() - start,
            });
            return data;
          });
          const summary = rpc.query('article.summary').then((data) => {
            summaryDone = true;
            samples.push({
              round,
              mode,
              phase: 'summary',
              ms: performance.now() - start,
            });
            return data;
          });
          await inFlight;
          if (mode === 'current') {
            await Promise.race([
              Promise.all([body, summary]),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(Error('READING_HELD_BY_BACKGROUND')),
                  1500,
                ),
              ),
            ]);
            assert(
              bodyDone && summaryDone,
              'both reading responses finish while background remains held',
            );
            release();
          } else {
            await new Promise((done) => setTimeout(done, 300));
            assert(
              !bodyDone && !summaryDone,
              'baseline body/summary wait for the same batch',
            );
            release();
          }
          await Promise.all([slow, body, summary]);
        }
      const condition = predicate(modes.at(-1));
      await assert.rejects(
        client(condition, 'wrong').query('article.byId'),
        /UNAUTHORIZED/,
      );
      holdBody = true;
      const bodyStarted = new Promise((done) => {
        bodyEntered = done;
      });
      const abort = new AbortController();
      const pending = client(condition).query('article.byId', undefined, {
        signal: abort.signal,
      });
      await bodyStarted;
      abort.abort();
      await assert.rejects(pending);
      bodyRelease();
      if (process.env.READING_TRANSPORT_OUTPUT) {
        const target = path.resolve(process.env.READING_TRANSPORT_OUTPUT);
        assert(target.startsWith(path.resolve('output') + path.sep));
        fs.writeFileSync(
          target,
          JSON.stringify(
            {
              scope:
                'installed provider predicate + real local tRPC HTTP; synthetic background held300ms; not normal page latency',
              samples,
              requests,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      release?.();
      bodyRelease?.();
      await new Promise((done) => listener.close(done));
    }
  },
);
