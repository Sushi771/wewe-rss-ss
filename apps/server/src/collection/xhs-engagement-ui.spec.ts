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
compiled.require = (name: string) =>
  name === '@web/utils/trpc'
    ? {
        trpc: {
          xiaohongshu: {
            engagement: { useQuery: () => ({ data: undefined, error: null }) },
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
  it('does not show empty metric/comment tables or request collection', () => {
    const html = renderToStaticMarkup(
      React.createElement(XhsEngagementPanel, {
        creatorId: 'synthetic',
        noteId: 'synthetic',
        initial: empty,
      }),
    );
    expect(html).not.toContain('已保存评论');
    expect(html).not.toContain('未知');
    expect(source).not.toContain('collectComments');
  });
  it('renders zero, missing, historical time, partial state and escaped user text', () => {
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
    const html = renderToStaticMarkup(
      React.createElement(XhsEngagementPanel, {
        creatorId: 'synthetic',
        noteId: 'synthetic',
        initial: view,
      }),
    );
    expect(html).toContain('赞 0');
    expect(html).toContain('分享 未知');
    expect(html).toContain('采集于');
    expect(html).toContain('失败，保留部分结果');
    expect(html).toContain('精确回复对象');
    expect(html).toContain('未知');
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html.indexOf('root body')).toBeLessThan(html.indexOf('reply body'));
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
    ).toBe('');
  });
});
