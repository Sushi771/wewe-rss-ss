/** Fictional, memory-only UI state. No transport or supplier response model. */
export type DemoStatus =
  | 'idle'
  | 'unconfigured'
  | 'needs-verification'
  | 'queued'
  | 'running'
  | 'complete'
  | 'failed'
  | 'cancelled';
export interface DemoAuthor {
  id: string;
  name: string;
  platform: 'wechat' | 'xiaohongshu';
  source: string;
  readiness: 'ready' | 'unconfigured' | 'needs-verification';
  outcome: 'complete' | 'failed';
}
export const demoAuthors: DemoAuthor[] = [
  {
    id: 'demo-wx-ready',
    name: '示例 · 山间来信',
    platform: 'wechat',
    source: 'Wechat2RSS',
    readiness: 'ready',
    outcome: 'complete',
  },
  {
    id: 'demo-wx-unconfigured',
    name: '示例 · 城市散步',
    platform: 'wechat',
    source: 'Wechat2RSS',
    readiness: 'unconfigured',
    outcome: 'complete',
  },
  {
    id: 'demo-xhs-verification',
    name: '示例 · 小屋日记',
    platform: 'xiaohongshu',
    source: '小红书候选来源',
    readiness: 'needs-verification',
    outcome: 'complete',
  },
  {
    id: 'demo-xhs-failure',
    name: '示例 · 每日一页',
    platform: 'xiaohongshu',
    source: '小红书候选来源',
    readiness: 'ready',
    outcome: 'failed',
  },
];
export interface DemoState {
  connected: false;
  selected: string[];
  results: Record<string, { status: DemoStatus; stage: number }>;
  queue: string[];
  batchIds: string[];
  activeIndex: number;
  busy: boolean;
  cancelRequested: boolean;
  run: number;
}
export const demoStages = ['读取列表', '读取正文', '归档图片'];
export function initialDemoState(): DemoState {
  return {
    connected: false,
    selected: demoAuthors.map((a) => a.id),
    results: Object.fromEntries(
      demoAuthors.map((a) => [
        a.id,
        { status: a.readiness === 'ready' ? 'idle' : a.readiness, stage: 0 },
      ]),
    ),
    queue: [],
    batchIds: [],
    activeIndex: 0,
    busy: false,
    cancelRequested: false,
    run: 0,
  };
}
export function selectDemoAuthor(
  state: DemoState,
  id: string,
  selected: boolean,
): DemoState {
  if (state.busy || !demoAuthors.some((a) => a.id === id)) return state;
  return {
    ...state,
    selected: selected
      ? [...new Set([...state.selected, id])]
      : state.selected.filter((key) => key !== id),
  };
}
export function startDemo(state: DemoState): DemoState {
  if (state.busy) return state;
  const queue = demoAuthors
    .filter((a) => state.selected.includes(a.id) && a.readiness === 'ready')
    .map((a) => a.id);
  if (!queue.length) return state;
  const results = { ...state.results };
  for (const id of queue) results[id] = { status: 'queued', stage: 0 };
  return {
    ...state,
    results,
    queue,
    batchIds: [...queue],
    activeIndex: 0,
    busy: true,
    cancelRequested: false,
    run: state.run + 1,
  };
}
export function cancelDemo(state: DemoState): DemoState {
  if (!state.busy || state.cancelRequested) return state;
  const results = { ...state.results };
  for (const id of state.queue.slice(state.activeIndex + 1))
    results[id] = { status: 'cancelled', stage: 0 };
  return { ...state, results, cancelRequested: true };
}
export function advanceDemo(state: DemoState): DemoState {
  if (!state.busy) return state;
  const id = state.queue[state.activeIndex];
  const current = state.results[id];
  const author = demoAuthors.find((a) => a.id === id)!;
  const results = { ...state.results };
  if (current.status === 'queued')
    results[id] = { status: 'running', stage: 0 };
  else if (current.stage < demoStages.length - 1)
    results[id] = { status: 'running', stage: current.stage + 1 };
  else {
    results[id] = { status: author.outcome, stage: 3 };
    const activeIndex = state.activeIndex + 1;
    if (state.cancelRequested || activeIndex === state.queue.length)
      return { ...state, results, busy: false, queue: [], activeIndex: 0 };
    return { ...state, results, activeIndex };
  }
  return { ...state, results };
}
export function demoResultMessage(
  result: DemoState['results'][string],
): string {
  switch (result.status) {
    case 'unconfigured':
      return '来源未就绪 · 等待采购、部署和配置';
    case 'needs-verification':
      return '待验证 · 需要正常验证与接口实样';
    case 'queued':
      return '演示排队中';
    case 'running':
      return `演示中 · ${demoStages[result.stage]}`;
    case 'complete':
      return '演示完成 · 示例图文已归档';
    case 'failed':
      return '演示失败 · 来源受限，已有示例保持';
    case 'cancelled':
      return '已停止未开始的演示项';
    default:
      return '可演示 · 真实来源仍未连接';
  }
}
