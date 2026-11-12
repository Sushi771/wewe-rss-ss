import { XhsSubscriptionService } from './xhs-subscription.service';

it('projects the legacy history count without changing task status or stored evidence', () => {
  const service = Object.create(XhsSubscriptionService.prototype) as any;
  service.pending = new Map();
  service.uncertain = new Map();
  const task = {
    taskId: 'synthetic',
    creatorId: 'author',
    kind: 'list',
    state: 'partial',
    code: 'XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED',
    message:
      '历史待核对：${t.historyExcludedIds!.length} 篇，其余基础采集已完成。',
    historyExcludedIds: ['first', 'second'],
    noteIds: [],
    items: {},
    total: 131,
    completed: 131,
    skipped: 0,
    failed: 0,
    remaining: 0,
  };
  const before = JSON.stringify(task);
  const view = service.view(task);
  expect(view.message).toBe('历史待核对：2 篇，其余基础采集已完成。');
  expect(view.state).toBe('partial');
  expect(view.code).toBe(task.code);
  expect(view.completed).toBe(131);
  expect(JSON.stringify(task)).toBe(before);
});
