import { wechatOriginalUrl } from '../../../web/src/utils/wechat-original-url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const filename = path.resolve(
  __dirname,
  '../../../web/src/pages/feeds/list.tsx',
);
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(
  filename,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const elements: ts.JsxOpeningLikeElement[] = [];
const expressions: Record<string, string> = {};
function visit(node: ts.Node) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    elements.push(node);
  if (ts.isVariableDeclaration(node) && node.initializer)
    expressions[node.name.getText(ast)] = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
function attribute(node: ts.JsxOpeningLikeElement, name: string) {
  return node.attributes.properties.find(
    (prop): prop is ts.JsxAttribute =>
      ts.isJsxAttribute(prop) && prop.name.getText(ast) === name,
  )?.initializer;
}
function literal(node: ts.JsxOpeningLikeElement, name: string) {
  const value = attribute(node, name);
  if (
    value &&
    ts.isJsxExpression(value) &&
    value.expression &&
    ts.isTemplateExpression(value.expression)
  ) {
    // Resolve the actual class expression for a complete cached fixture row.
    return String(
      evaluate(value.expression.getText(ast), {
        item: { bodyCached: true, lastBodyStatus: 'available' },
      }),
    );
  }
  return value && ts.isStringLiteral(value) ? value.text : '';
}
function elementWithClass(marker: string) {
  const element = elements.find((node) =>
    literal(node, 'className').split(/\s+/).includes(marker),
  );
  if (!element)
    throw new Error('Actual article-list element missing: ' + marker);
  return element;
}
function handler(node: ts.JsxOpeningLikeElement, name: string) {
  const value = attribute(node, name);
  if (!value || !ts.isJsxExpression(value) || !value.expression)
    throw new Error('Actual article-list handler missing: ' + name);
  return value.expression.getText(ast);
}
function evaluate(expression: string, scope: Record<string, unknown>) {
  const context = { module: { exports: undefined as unknown }, ...scope };
  vm.runInNewContext(
    ts.transpileModule('module.exports = ' + expression, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2021,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    context,
    { timeout: 1000 },
  );
  return context.module.exports as (...args: unknown[]) => unknown;
}

describe('actual WeChat article-list mobile layout contract and handlers (offline, not visual acceptance)', () => {
  it('uses the shared bounded mobile grid and second-row metadata', () => {
    expect(literal(elementWithClass('article-row'), 'className')).toContain(
      'content-article-row',
    );
    expect(literal(elementWithClass('compact-title'), 'className')).toContain(
      'min-w-0',
    );
    expect(literal(elementWithClass('compact-title'), 'className')).toContain(
      '!whitespace-normal',
    );
    expect(elementWithClass('content-article-metadata')).toBeDefined();
    const css = fs.readFileSync(
      path.resolve(__dirname, '../../../web/src/index.css'),
      'utf8',
    );
    expect(css).toContain('grid-template-columns: 24px minmax(0, 1fr);');
    expect(css).toContain('grid-column: 2;');
  });
  it('uses the reading container breakpoint for a bounded desktop metadata column', () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, '../../../web/src/index.css'),
      'utf8',
    );
    expect(css).toContain('@container reading (min-width: 900px)');
    expect(css).toContain(
      'grid-template-columns: 24px minmax(0, 1fr) minmax(200px, 300px);',
    );
    expect(css).toContain('grid-column: 3;');
  });
  it.each([true, false])(
    'retains per-article checkbox selection (%s)',
    (selected) => {
      const checkbox = elements.find(
        (node) =>
          handlerOrEmpty(node, 'isSelected') === 'selectedIds.has(item.id)',
      );
      expect(checkbox).toBeDefined();
      const changed = jest.fn();
      evaluate(handler(checkbox!, 'onValueChange'), {
        item: { id: 'a' },
        selectedIds: new Set(['a', 'b']),
        isSelectionDisabled: false,
        onSelectionChange: changed,
      })(selected);
      expect([...changed.mock.calls[0][0]]).toEqual(
        selected ? ['a', 'b'] : ['b'],
      );
    },
  );
  it.each([true, false])(
    'opens only stored official source URLs independently of cached body (%s)',
    (bodyCached) => {
      const node = elementWithClass('compact-title'),
        capture = jest.fn();
      const item = {
        id: 'internal-id',
        bodyCached,
        sourceUrl: 'https://mp.weixin.qq.com/s/synthetic',
        title: 'Synthetic',
      };
      expect(evaluate(handler(node, 'href'), { item, wechatOriginalUrl })).toBe(
        item.sourceUrl,
      );
      expect(literal(node, 'target')).toBe('_blank');
      evaluate(handler(node, 'onClick'), {
        position: { capturePosition: capture },
      })({});
      expect(capture).toHaveBeenCalledTimes(1);
      expect(
        evaluate(handler(node, 'href'), {
          item: { ...item, sourceUrl: 'https://evil.example/' },
          wechatOriginalUrl,
        }),
      ).toBeUndefined();
      expect(
        evaluate(handler(node, 'aria-disabled'), {
          item: { ...item, sourceUrl: undefined },
          wechatOriginalUrl,
        }),
      ).toBe(true);
    },
  );
  it('keeps sorting and clears old selection when the sort changes', () => {
    const select = elements.find(
      (node) => node.tagName.getText(ast) === 'ContentSortControls',
    );
    const setSort = jest.fn();
    const changed = jest.fn();
    evaluate(handler(select!, 'onSortChange'), {
      setSort,
      onSelectionChange: changed,
    })('likeCount');
    expect(setSort).toHaveBeenCalledWith('likeCount');
    expect(changed.mock.calls[0][0].size).toBe(0);
  });
  it('keeps loaded-list selection independent of responsive presentation', () => {
    const changed = jest.fn();
    const selectAll = evaluate(expressions.handleSelectAll, {
      items: [{ id: 'a' }, { id: 'b' }],
      isSelectionDisabled: false,
      onSelectionChange: changed,
    });
    selectAll(true);
    expect([...changed.mock.calls[0][0]]).toEqual(['a', 'b']);
    selectAll(false);
    expect(changed.mock.calls[1][0].size).toBe(0);
  });
});

function handlerOrEmpty(node: ts.JsxOpeningLikeElement, name: string) {
  const value = attribute(node, name);
  return value && ts.isJsxExpression(value) && value.expression
    ? value.expression.getText(ast)
    : '';
}
