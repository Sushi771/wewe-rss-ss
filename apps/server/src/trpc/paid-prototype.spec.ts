import {
  advanceDemo,
  cancelDemo,
  demoAuthors,
  demoResultMessage,
  initialDemoState,
  selectDemoAuthor,
  startDemo,
} from '../../../web/src/prototypes/paid-subscriptions-model';
import * as fs from 'node:fs';
import * as path from 'node:path';

function finish(state: ReturnType<typeof initialDemoState>) {
  for (let n = 0; state.busy && n < 40; n++) state = advanceDemo(state);
  if (state.busy) throw new Error('DEMO_DID_NOT_FINISH');
  return state;
}

describe('isolated cross-device prototype (actual memory-only model)', () => {
  let network: jest.SpyInstance;
  beforeEach(() => {
    network = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
  it('is disconnected in every phase, with unavailable and verification states visible', () => {
    const state = initialDemoState();
    expect(state.connected).toBe(false);
    expect(state.results['demo-wx-unconfigured'].status).toBe('unconfigured');
    expect(state.results['demo-xhs-verification'].status).toBe(
      'needs-verification',
    );
    expect(finish(startDemo(state)).connected).toBe(false);
  });
  it('updates only chosen, demo-ready sources and preserves all unavailable states', () => {
    const initial = initialDemoState();
    const state = finish(startDemo(initial));
    expect(state.results['demo-wx-ready'].status).toBe('complete');
    expect(state.results['demo-xhs-failure'].status).toBe('failed');
    expect(state.results['demo-wx-unconfigured']).toEqual(
      initial.results['demo-wx-unconfigured'],
    );
    expect(state.results['demo-xhs-verification']).toEqual(
      initial.results['demo-xhs-verification'],
    );
    expect(initial.results['demo-wx-ready'].status).toBe('idle');
  });
  it('shows list/body/media progress before outcome, without equating ended and complete', () => {
    let state = startDemo(initialDemoState());
    const messages: string[] = [];
    for (let n = 0; n < 3; n++) {
      state = advanceDemo(state);
      messages.push(demoResultMessage(state.results['demo-wx-ready']));
    }
    expect(messages).toEqual([
      '演示中 · 读取列表',
      '演示中 · 读取正文',
      '演示中 · 归档图片',
    ]);
    expect(
      demoResultMessage(finish(state).results['demo-xhs-failure']),
    ).toContain('失败');
  });
  it('rejects duplicate start and changing selection during the active batch', () => {
    const state = startDemo(initialDemoState());
    expect(startDemo(state)).toBe(state);
    expect(selectDemoAuthor(state, 'demo-wx-ready', false)).toBe(state);
    expect(state.run).toBe(1);
  });
  it('cancel lets current demonstration settle, stops unsent items and never changes source', () => {
    const active = advanceDemo(startDemo(initialDemoState()));
    const cancelled = cancelDemo(active);
    expect(cancelDemo(cancelled)).toBe(cancelled);
    expect(cancelled.results['demo-xhs-failure'].status).toBe('cancelled');
    const done = finish(cancelled);
    expect(done.results['demo-wx-ready'].status).toBe('complete');
    expect(done.results['demo-xhs-failure'].status).toBe('cancelled');
    expect(done.busy).toBe(false);
    expect(done.connected).toBe(false);
  });
  it('a subsequent explicit run clears cancellation, while reset does not auto-start', () => {
    const done = finish(cancelDemo(startDemo(initialDemoState())));
    const next = startDemo(done);
    expect(next.cancelRequested).toBe(false);
    expect(next.run).toBe(2);
    expect(initialDemoState().busy).toBe(false);
  });
  it('platform/source isolation leaves a deselected ready author untouched', () => {
    const selected = selectDemoAuthor(
      initialDemoState(),
      'demo-xhs-failure',
      false,
    );
    const state = finish(startDemo(selected));
    expect(state.results['demo-xhs-failure'].status).toBe('idle');
    expect(state.results['demo-wx-ready'].status).toBe('complete');
    expect(selectDemoAuthor(state, 'unknown-author', true)).toBe(state);
  });
  it('selecting only blocked sources does not create a batch', () => {
    let state = initialDemoState();
    for (const author of demoAuthors.filter((a) => a.readiness === 'ready'))
      state = selectDemoAuthor(state, author.id, false);
    expect(startDemo(state)).toBe(state);
  });
  it('a new batch counts its own scope, preserving an earlier unselected success', () => {
    const first = finish(startDemo(initialDemoState()));
    const second = finish(
      startDemo(selectDemoAuthor(first, 'demo-wx-ready', false)),
    );
    expect(second.batchIds).toEqual(['demo-xhs-failure']);
    expect(second.results['demo-wx-ready'].status).toBe('complete');
    expect(
      second.batchIds.filter((id) => second.results[id].status === 'complete'),
    ).toHaveLength(0);
  });
  it('entry and controls remain separate from App/TRPC, with a mobile drawer and desktop list', () => {
    const ui = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../web/src/prototypes/paid-subscriptions.tsx',
      ),
      'utf8',
    );
    const css = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../web/src/prototypes/paid-subscriptions.css',
      ),
      'utf8',
    );
    const app = fs.readFileSync(
      path.resolve(__dirname, '../../../web/src/App.tsx'),
      'utf8',
    );
    expect(ui).toContain('本机未连接 · 离线演示');
    expect(ui).toContain('更新全部（未连接）');
    expect(ui).toContain('scrollBehavior="inside"');
    expect(css).toContain('@media (max-width: 760px)');
    expect(css).toContain('.demo-desktop-list');
    expect(ui).not.toMatch(
      /trpc|fetch\(|XMLHttpRequest|localStorage|sessionStorage/,
    );
    expect(app).not.toContain('paid-subscriptions');
  });
});
