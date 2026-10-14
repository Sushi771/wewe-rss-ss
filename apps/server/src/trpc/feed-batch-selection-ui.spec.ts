import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import axios from 'axios';
import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';
import { getLoadedSelection } from '../../../web/src/utils/feed-selection';
import { articleBodyState } from '../../../web/src/utils/article-body-state';

// Execute the actual handlers and component, with offline query/hook fixtures.
// This checks behavior and accessibility props; it is not browser visual proof.
function inspect(relative: string) {
  const filename = path.resolve(__dirname, '../../../web/src/', relative);
  const text = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const expressions: Record<string, string> = {};
  const elements: ts.JsxOpeningLikeElement[] = [];
  const effects: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer)
      expressions[node.name.getText(ast)] = node.initializer.getText(ast);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      elements.push(node);
    if (
      ts.isCallExpression(node) &&
      ['useEffect', 'useLayoutEffect'].includes(node.expression.getText(ast))
    )
      effects.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  function prop(element: ts.JsxOpeningLikeElement, name: string) {
    const attr = element.attributes.properties.find(
      (p): p is ts.JsxAttribute =>
        ts.isJsxAttribute(p) && p.name.getText(ast) === name,
    )?.initializer;
    return attr && ts.isJsxExpression(attr)
      ? attr.expression?.getText(ast)
      : attr && ts.isStringLiteral(attr)
        ? JSON.stringify(attr.text)
        : undefined;
  }
  return { text, ast, expressions, elements, effects, prop };
}
const list = inspect('pages/feeds/list.tsx');
const index = inspect('pages/feeds/index.tsx');
function evaluate(
  expression: string,
  scope: Record<string, unknown> = {},
): any {
  const context = {
    module: { exports: undefined },
    Set,
    Array,
    Error,
    exportCancelled: { current: false },
    ...scope,
  };
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
  return context.module.exports;
}
function exportFixture(ids: string[], save: (id: string) => Promise<any>) {
  const state = { selected: new Set(ids), busy: false };
  const scope = {
    articleSelectedIds: state.selected,
    batchExporting: { current: false },
    exportCancelled: { current: false },
    dateError: undefined,
    setExportResult: jest.fn(),
    setIsBatchExporting: (busy: boolean) => {
      state.busy = busy;
    },
    setArticleSelectedIds: (
      next: Set<string> | ((ids: Set<string>) => Set<string>),
    ) => {
      state.selected = typeof next === 'function' ? next(state.selected) : next;
    },
    queryUtils: { client: { article: { saveToObsidian: { mutate: save } } } },
    toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
  };
  return {
    state,
    scope,
    run: evaluate(index.expressions.handleBatchExport, scope),
  };
}

function listFixture(initialItems: string[]) {
  const state: any[] = [];
  const dependencies: any[][] = [];
  let hook = 0,
    changed = false;
  let items = initialItems;
  let data: any;
  let selected = new Set<string>();
  let params = { id: 'feed-a' };
  let props: any = { search: '', articleFilter: {}, direction: 'desc' };
  const effects: Array<() => void> = [];
  const changeSelection = (next: Set<string>) => {
    selected = next;
    changed = true;
  };
  const registerEffect = (fn: () => void, deps: any[]) => {
    const i = hook++;
    if (
      !dependencies[i] ||
      deps.some((d, n) => !Object.is(d, dependencies[i][n]))
    )
      effects.push(fn);
    dependencies[i] = deps;
  };
  const jsx = (type: any, props: any) => ({ type, props: props || {} });
  const react = {
    useState(value: any) {
      const i = hook++;
      if (!(i in state)) state[i] = value;
      return [
        state[i],
        (next: any) => {
          state[i] = next;
          changed = true;
        },
      ];
    },
    useMemo: (fn: () => any) => fn(),
    useEffect: registerEffect,
    useLayoutEffect: registerEffect,
  };
  const trpc = {
    article: {
      byId: { useQuery: () => ({}) },
      summary: { useQuery: () => ({ data: { articles: items.length } }) },
      retryBody: { useMutation: () => ({}) },
      list: {
        useInfiniteQuery: () => ({
          data,
          isLoading: false,
          fetchNextPage: jest.fn(),
          hasNextPage: true,
        }),
      },
    },
    useUtils: () => ({}),
  };
  const mod = { exports: {} as any };
  const compiled = ts.transpileModule(list.text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const requireMock = (name: string) =>
    name === '@web/utils/article-body-state'
      ? { articleBodyState }
      : name === 'react'
        ? react
        : name === 'react/jsx-runtime'
          ? { jsx, jsxs: jsx }
          : name === '@nextui-org/react'
            ? Object.fromEntries(
                [
                  'Checkbox',
                  'Button',
                  'Spinner',
                  'Modal',
                  'ModalContent',
                  'ModalHeader',
                  'ModalBody',
                ].map((n) => [n, n]),
              )
            : name === '@web/utils/trpc'
              ? { trpc }
              : name === '@web/utils/feed-selection'
                ? { getLoadedSelection }
                : name === '@web/utils/use-article-list-position'
                  ? {
                      useArticleListPosition: () => ({
                        scrollRef: { current: null },
                        capturePosition() {},
                        cancelRestore() {},
                        rememberForReader() {},
                        restoreAfterReader() {},
                      }),
                    }
                  : name === 'react-router-dom'
                    ? { useParams: () => params }
                    : name === '@wewe-rss/shared'
                      ? { formatShanghaiPublicationTime: () => 'fixture-time' }
                      : {};
  new Function('require', 'exports', 'module', compiled)(
    requireMock,
    mod.exports,
    mod,
  );
  function all(node: any): any[] {
    return node == null
      ? []
      : Array.isArray(node)
        ? node.flatMap(all)
        : typeof node === 'object'
          ? [node, ...all(node.props?.children)]
          : [node];
  }
  function render() {
    let tree: any;
    for (let i = 0; i < 12; i++) {
      changed = false;
      hook = 0;
      tree = mod.exports.default({
        ...props,
        selectedIds: selected,
        onSelectionChange: changeSelection,
        onDirectionChange: (direction: string) => {
          props.direction = direction;
        },
      });
      effects.splice(0).forEach((effect) => effect());
      if (!changed) return all(tree);
    }
    throw Error('Selection fixture did not settle');
  }
  const setItems = (next: string[]) => {
    items = next;
    data = {
      pages: [
        {
          items: next.map((id) => ({
            id,
            title: '标题' + id,
            mpId: 'feed-a',
            bodyCached: true,
            bodyRetry: { allowed: false },
            publishTime: 0,
          })),
        },
      ],
    };
  };
  setItems(initialItems);
  const checkbox = (nodes: any[]) =>
    nodes.find(
      (n) => n.type === 'Checkbox' && n.props['aria-label'] === '全选已加载',
    );
  return {
    render,
    checkbox,
    setItems,
    getSelected: () => Array.from(selected),
    setSelected: changeSelection,
    setProps: (next: any) => {
      props = { ...props, ...next };
    },
    setFeed: (id: string) => {
      params = { id };
    },
  };
}

describe('feed batch selection actual UI and export handlers, offline', () => {
  it.each([
    [[], [], false, false],
    [['a', 'b'], [], false, false],
    [['a', 'b'], ['a'], false, true],
    [['a', 'b'], ['a', 'b'], true, false],
    [['a', 'b'], ['a', 'foreign'], false, true],
    [['a', 'b'], ['foreign', 'other'], false, false],
  ])(
    'compares loaded IDs, including equal counts with different IDs (%j / %j)',
    (ids, selected, all, partial) => {
      const state = getLoadedSelection(
        (ids as string[]).map((id) => ({ id })),
        new Set(selected as string[]),
      );
      expect(state.allSelected).toBe(all);
      expect(state.isIndeterminate).toBe(partial);
    },
  );
  it('deduplicates loaded IDs and selects only those IDs', () => {
    const f = listFixture(['a', 'a', 'b']);
    f.checkbox(f.render()).props.onValueChange(true);
    expect(f.getSelected()).toEqual(['a', 'b']);
    expect(f.checkbox(f.render()).props.isSelected).toBe(true);
  });
  it('keeps old selected IDs when another page loads and turns full selection into partial', () => {
    const f = listFixture(['a', 'b']);
    f.checkbox(f.render()).props.onValueChange(true);
    f.render();
    f.setItems(['a', 'b', 'c']);
    const nodes = f.render();
    expect(f.getSelected()).toEqual(['a', 'b']);
    expect(f.checkbox(nodes).props.isSelected).toBe(false);
    expect(f.checkbox(nodes).props.isIndeterminate).toBe(true);
    expect(
      nodes.find((n) => n.props?.['aria-label'] === '选择文章：标题c').props
        .isSelected,
    ).toBe(false);
  });
  it('prunes hidden IDs on a list reread without selecting replacement rows', () => {
    const f = listFixture(['a', 'b']);
    f.render();
    f.setSelected(new Set(['a', 'b']));
    f.setItems(['b', 'c']);
    expect(f.checkbox(f.render()).props.isIndeterminate).toBe(true);
    expect(f.getSelected()).toEqual(['b']);
  });
  it('clears empty and invalid filters even when all old IDs were selected', () => {
    const f = listFixture(['a', 'b']);
    f.render();
    f.setSelected(new Set(['a', 'b']));
    f.setProps({ filterInvalid: true });
    expect(f.checkbox(f.render()).props.isDisabled).toBe(true);
    expect(f.getSelected()).toEqual([]);
  });
  it.each(['search', 'feed'])('clears selection when %s changes', (field) => {
    const f = listFixture(['a']);
    f.render();
    f.setSelected(new Set(['a']));
    f.render();
    if (field === 'search') f.setProps({ search: 'other' });
    else f.setFeed('other');
    f.render();
    expect(f.getSelected()).toEqual([]);
  });
  it('preserves parent clearing for feed/search/folder/date changes and keyed query scope', () => {
    const reset = index.effects.find((node) =>
      [
        'id',
        'search',
        'folderFilter',
        'articleDates',
        'articleDirection',
        'articleSort',
        'browseGeneration',
      ].every((name) => node.arguments[1]?.getText(index.ast).includes(name)),
    );
    expect(reset).toBeDefined();
    const cleared = jest.fn();
    evaluate(reset!.arguments[0].getText(index.ast), {
      setArticleSelectedIds: cleared,
    })();
    expect(cleared.mock.calls[0][0].size).toBe(0);
    const child = index.elements.find(
      (node) => node.tagName.getText(index.ast) === 'ArticleList',
    )!;
    expect(index.prop(child, 'key')).toContain('articleDateFilter');
    expect(index.prop(child, 'key')).toContain('folderFilter');
    expect(index.prop(child, 'isSelectionDisabled')).toBe('isBatchExporting');
  });
  it('clears on sort/direction changes and unchecking all, and labels keyboard reachable controls', () => {
    const f = listFixture(['a', 'b']);
    let nodes = f.render();
    f.checkbox(nodes).props.onValueChange(true);
    nodes = f.render();
    // Direction is controlled by the parent toolbar. Pass the new query scope
    // after the actual parent selection reset tested above.
    const reset = index.effects.find((node) =>
      node.arguments[1]?.getText(index.ast).includes('articleDirection'),
    )!;
    evaluate(reset.arguments[0].getText(index.ast), {
      setArticleSelectedIds: f.setSelected,
    })();
    f.setProps({ direction: 'asc' });
    f.render();
    expect(f.getSelected()).toEqual([]);
    f.checkbox(f.render()).props.onValueChange(true);
    f.checkbox(f.render()).props.onValueChange(false);
    expect(f.getSelected()).toEqual([]);
    expect(
      nodes
        .filter((n) => n.type === 'Checkbox')
        .every((n) => !!n.props['aria-label']),
    ).toBe(true);
    expect(
      nodes.some((n) => n.type === 'Checkbox' && n.props.tabIndex === -1),
    ).toBe(false);
  });
  it('locks checkbox handlers during export and renders count/clear independently of export availability', () => {
    const f = listFixture(['a']);
    f.render();
    f.setProps({ isSelectionDisabled: true });
    const nodes = f.render();
    const all = f.checkbox(nodes);
    expect(all.props.isDisabled).toBe(true);
    all.props.onValueChange(true);
    nodes
      .find((n) => n.props?.['aria-label'] === '选择文章：标题a')
      .props.onValueChange(true);
    expect(f.getSelected()).toEqual([]);
    const clear = index.elements.find(
      (n) =>
        n.tagName.getText(index.ast) === 'Button' &&
        index.prop(n, 'onPress')?.includes('!batchExporting.current'),
    )!;
    const changed = jest.fn();
    evaluate(index.prop(clear, 'onPress')!, {
      batchExporting: { current: false },
      exportCancelled: { current: false },
      dateError: undefined,
      setExportResult: jest.fn(),
      setArticleSelectedIds: changed,
    })();
    expect(changed.mock.calls[0][0].size).toBe(0);
    changed.mockClear();
    evaluate(index.prop(clear, 'onPress')!, {
      batchExporting: { current: true },
      setArticleSelectedIds: changed,
    })();
    expect(changed).not.toHaveBeenCalled();
    expect(index.text).toContain('已选 {articleSelectedIds.size} 篇');
    expect(index.text).toContain('flex min-w-0 flex-wrap items-center gap-2');
  });
  it('exports the snapshot IDs exactly once despite rapid repeated submit and clears on success', async () => {
    let finish!: (result: any) => void;
    const save = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({});
    const f = exportFixture(['b', 'a'], save);
    const pending = f.run();
    await f.run();
    expect(save.mock.calls).toEqual([['b']]);
    expect(f.state.busy).toBe(true);
    finish({});
    await pending;
    expect(save.mock.calls).toEqual([['b'], ['a']]);
    expect(f.state.selected.size).toBe(0);
    expect(f.state.busy).toBe(false);
    expect(f.scope.batchExporting.current).toBe(false);
  });
  it('continues after failure, retains the entire original selection and releases the lock', async () => {
    const save = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('ISOLATED_FAILURE'))
      .mockResolvedValue({});
    const f = exportFixture(['b', 'a', 'c'], save);
    await f.run();
    expect(save.mock.calls).toEqual([['b'], ['a'], ['c']]);
    expect(Array.from(f.state.selected)).toEqual(['b', 'a', 'c']);
    expect(f.scope.toast.warning.mock.calls[0][0]).toContain('失败 1');
    expect(f.state.busy).toBe(false);
    expect(f.scope.batchExporting.current).toBe(false);
  });
  it('does not submit empty selection or erase a later scope selection when an old export resolves', async () => {
    const save = jest.fn().mockResolvedValue({});
    await exportFixture([], save).run();
    expect(save).not.toHaveBeenCalled();
    let finish!: (result: any) => void;
    save.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = exportFixture(['a'], save);
    const pending = f.run();
    f.state.selected = new Set(['new-scope']);
    finish({});
    await pending;
    expect(Array.from(f.state.selected)).toEqual(['new-scope']);
    expect(save.mock.calls).toEqual([['a']]);
  });
});

describe('selected UI IDs through original cached-article router/exporter into temporary files', () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
  let root: string;
  const oldEnv = { ...process.env };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-feed-selection-'));
    delete process.env.PRIVATE_ONLINE_MODE;
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('NO_NETWORK'));
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NO_NETWORK'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...oldEnv };
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith('wewe-feed-selection-')
    )
      throw new Error('Refusing to remove a directory outside this fixture');
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('writes only checkbox-selected IDs and matching cached bodies/images; failure retains selection and existing edits', async () => {
    const ids = [
      'WX_1234567890_2247000001_1',
      'WX_1234567890_2247000002_1',
      'WX_1234567890_2247000003_1',
    ];
    const articles = ids.map((id, i) => ({
      id,
      title: '隔离文章' + i,
      sourceUrl: null,
      publishTime: 1791210060,
      lastBodyStatus: 'available',
      metrics: null,
      contentHtml: `<div id="js_content"><p>隔离正文${i}</p><img src="data:image/png;base64,${png}"></div>`,
      feed: {
        id: 'MP_WXS_1234567890',
        mpName: '合成号',
        group: { id: 'group-a', name: '合成组' },
      },
    }));
    const prisma = {
      article: {
        findUnique: jest.fn(async ({ where }) =>
          articles.find((item) => item.id === where.id),
        ),
      },
    };
    const config = {
      get: (key: string) =>
        key === 'feed' ? { obsidianPath: path.join(root, 'vault') } : {},
    };
    const service = new TrpcService(
      {} as any,
      config as any,
      {} as any,
      {} as any,
    );
    const router = new TrpcRouter(
      service,
      prisma as any,
      config as any,
      {} as any,
      {} as any,
    );
    const caller = router.appRouter.createCaller({ errorMsg: null });
    const saved: any[] = [];
    const save = jest.fn(async (id: string) => {
      const result = await caller.article.saveToObsidian(id);
      saved.push(result);
      return result;
    });
    const list = listFixture(ids);
    for (const id of [ids[2], ids[0]]) {
      list
        .render()
        .find((node) => node.props?.['aria-label'] === '选择文章：标题' + id)
        .props.onValueChange(true);
    }
    const f = exportFixture(list.getSelected(), save);
    await f.run();
    expect(save.mock.calls).toEqual([[ids[2]], [ids[0]]]);
    expect(
      prisma.article.findUnique.mock.calls.map((call) => call[0].where.id),
    ).toEqual([ids[2], ids[0]]);
    expect(f.state.selected.size).toBe(0);
    for (const [i, original] of [2, 0].entries()) {
      const md = fs.readFileSync(saved[i].path, 'utf8');
      expect(md).toContain('隔离正文' + original);
      const image = fs.readdirSync(
        path.join(path.dirname(saved[i].path), 'image'),
      )[0];
      expect(
        fs.readFileSync(path.join(path.dirname(saved[i].path), 'image', image)),
      ).toEqual(Buffer.from(png, 'base64'));
    }
    expect(
      fs
        .readdirSync(path.dirname(saved[0].path))
        .filter((name) => name.endsWith('.md')),
    ).toHaveLength(2);
    fs.writeFileSync(saved[0].path, '隔离模拟手写笔记');
    articles[1].contentHtml = '';
    articles[1].lastBodyStatus = 'unavailable';
    save.mockClear();
    const failed = exportFixture([ids[2], ids[1], ids[0]], save);
    await failed.run();
    expect(save.mock.calls).toEqual([[ids[2]], [ids[1]], [ids[0]]]);
    expect(Array.from(failed.state.selected)).toEqual([ids[2], ids[1], ids[0]]);
    expect(fs.readFileSync(saved[0].path, 'utf8')).toBe('隔离模拟手写笔记');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
});
