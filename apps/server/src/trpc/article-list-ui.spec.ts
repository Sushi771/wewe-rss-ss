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
  it('gives the mobile title its own bounded column and moves metadata to a second row', () => {
    const row = literal(elementWithClass('article-row'), 'className');
    const title = literal(elementWithClass('compact-title'), 'className');
    const metadata = literal(elementWithClass('col-start-2'), 'className');
    expect(row).toContain('!grid'); // Overrides the later .compact-row display:flex rule.
    expect(row).toContain('grid-cols-[24px_minmax(0,1fr)]');
    expect(title).toContain('min-w-0');
    expect(title).toContain('!whitespace-normal'); // Overrides .compact-title nowrap.
    expect(metadata).toContain('min-w-0');
    expect(metadata).toContain('w-auto');
    expect(metadata.split(/\s+/)).not.toContain('w-[300px]');
  });
  it('removes the fixed information header on mobile and preserves desktop flex, nowrap and 300px metadata', () => {
    expect(
      literal(elementWithClass('compact-col-metadata'), 'className'),
    ).toContain('!hidden md:!flex');
    expect(
      literal(elementWithClass('compact-col-title'), 'className'),
    ).toContain('whitespace-nowrap');
    expect(literal(elementWithClass('article-row'), 'className')).toContain(
      'md:!flex',
    );
    expect(literal(elementWithClass('compact-title'), 'className')).toContain(
      'md:!whitespace-nowrap',
    );
    expect(literal(elementWithClass('col-start-2'), 'className')).toContain(
      'md:w-[300px]',
    );
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
        onSelectionChange: changed,
      })(selected);
      expect([...changed.mock.calls[0][0]]).toEqual(
        selected ? ['a', 'b'] : ['b'],
      );
    },
  );
  it.each([true, false])(
    'retains cached-body reading and uncached source navigation (%s)',
    (bodyCached) => {
      const event = { preventDefault: jest.fn() };
      const setReadingId = jest.fn();
      evaluate(handler(elementWithClass('compact-title'), 'onClick'), {
        item: { id: 'a', bodyCached },
        setReadingId,
      })(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(bodyCached ? 1 : 0);
      expect(setReadingId.mock.calls).toEqual(bodyCached ? [['a']] : []);
    },
  );
  it('keeps sorting and clears old selection when the sort changes', () => {
    const select = elements.find(
      (node) => literal(node, 'aria-label') === '文章排序',
    );
    const setSort = jest.fn();
    const changed = jest.fn();
    evaluate(handler(select!, 'onChange'), {
      setSort,
      onSelectionChange: changed,
    })({ target: { value: 'likeCount' } });
    expect(setSort).toHaveBeenCalledWith('likeCount');
    expect(changed.mock.calls[0][0].size).toBe(0);
  });
  it('keeps loaded-list selection independent of responsive presentation', () => {
    const changed = jest.fn();
    const selectAll = evaluate(expressions.handleSelectAll, {
      items: [{ id: 'a' }, { id: 'b' }],
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
