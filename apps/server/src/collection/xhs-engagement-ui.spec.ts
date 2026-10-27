import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire, Module } from 'node:module';
import * as ts from 'typescript';

const webRequire = createRequire(
  path.resolve(__dirname, '../../../web/package.json'),
);
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const file = path.resolve(
  __dirname,
  '../../../web/src/components/XhsEngagement.tsx',
);
const compiled = new (Module as any)(file);
const source = readFileSync(file, 'utf8');
let savedView: unknown;
const queryCalls: unknown[][] = [];
compiled.require = (name: string) =>
  name === '@web/utils/trpc'
    ? {
        trpc: {
          useUtils: () => ({}),
          xiaohongshu: {
            collectComments: { useMutation: () => ({ isLoading: false }) },
            refreshMetrics: { useMutation: () => ({ isLoading: false }) },
            engagement: {
              useQuery: (...args: unknown[]) => {
                queryCalls.push(args);
                return { data: savedView, error: null };
              },
            },
          },
        },
      }
    : webRequire(name);
compiled._compile(
  ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText,
  file,
);
const { XhsMetricLine, XhsEngagementPanel, XhsNumericFilter } =
  compiled.exports;
const empty = {
  metrics: null,
  creatorMetrics: null,
  comments: [],
  windows: [],
  totalSaved: 0,
  returned: 0,
  offset: 0,
};
describe('actual XHS React business components with synthetic saved data (SSR)', () => {
  beforeEach(() => {
    savedView = undefined;
    queryCalls.length = 0;
  });
  it('shows unknown metrics honestly without requesting collection', () => {
    const html = renderToStaticMarkup(
      React.createElement(XhsMetricLine, { snapshot: null }),
    );
    expect(XhsEngagementPanel).toBeUndefined();
    expect(html).not.toContain('已保存评论');
    expect(html).toContain('赞 未知');
    expect(queryCalls).toEqual([]);
  });
  it('renders zero, unknown and historical time, hides old comments and escapes user text', () => {
    const view = {
      ...empty,
      metrics: {
        values: { likes: 0, collects: 12000, shares: null, comments: 2 },
        collectedAt: 1760000000000,
        evidence: 'source-only',
        contract: 'synthetic',
      },
      totalSaved: 2,
      returned: 2,
      windows: [
        {
          scope: 'top',
          pages: 1,
          state: 'failed',
          code: 'XHS_SOURCE_SIGNATURE_BLOCKED',
          collectedAt: 1760000000000,
        },
      ],
      comments: [
        {
          id: 'root',
          rootId: null,
          authorName: '<script>unsafe</script>',
          likes: 0,
          publishedAt: null,
          content: 'root body',
        },
        {
          id: 'child',
          rootId: 'root',
          parentId: null,
          authorName: 'Synthetic',
          likes: null,
          publishedAt: null,
          content: 'reply body',
        },
      ],
    };
    savedView = view;
    const html = renderToStaticMarkup(
      React.createElement(XhsMetricLine, { snapshot: view.metrics }),
    );
    expect(html).toContain('赞 0');
    expect(html).toContain('分享 未知');
    expect(html).toContain('历史快照');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('root body');
    expect(html).not.toContain('reply body');
    expect(queryCalls).toEqual([]);
    const escaped = renderToStaticMarkup(
      React.createElement(XhsNumericFilter, {
        value: { metric: 'likes', min: '<script>unsafe</script>' },
        onChange: () => {},
      }),
    );
    expect(escaped).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(escaped).not.toContain('<script>');
  });
  it('keeps the numeric filter controls accessible and bounded to local saved scope', () => {
    const html = renderToStaticMarkup(
      React.createElement(XhsNumericFilter, {
        value: { metric: 'likes', min: 0, max: 100 },
        onChange: () => {},
      }),
    );
    expect(html).toContain('aria-label="最小值"');
    expect(html).toContain('aria-label="最大值"');
    expect(html).toContain('平台已保存范围');
    expect(html).toContain('未知排末');
    expect(
      renderToStaticMarkup(
        React.createElement(XhsMetricLine, { snapshot: null }),
      ),
    ).toContain('赞 未知');
  });
});
