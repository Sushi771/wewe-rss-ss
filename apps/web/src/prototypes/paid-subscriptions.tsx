import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Button,
  Checkbox,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  NextUIProvider,
} from '@nextui-org/react';
import {
  advanceDemo,
  cancelDemo,
  demoAuthors,
  demoResultMessage,
  initialDemoState,
  selectDemoAuthor,
  startDemo,
} from './paid-subscriptions-model';
import '../index.css';
import './paid-subscriptions.css';

export default function PaidSubscriptionsPrototype() {
  const [state, setState] = useState(initialDemoState);
  const [filter, setFilter] = useState<'all' | 'wechat' | 'xiaohongshu'>('all');
  const [authorId, setAuthorId] = useState(demoAuthors[0].id);
  const [drawer, setDrawer] = useState(false);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (!state.busy) return;
    const timer = window.setTimeout(() => setState(advanceDemo), 700);
    return () => window.clearTimeout(timer);
  }, [state]);
  const visible = demoAuthors.filter(
    (a) => filter === 'all' || a.platform === filter,
  );
  const author = demoAuthors.find((a) => a.id === authorId)!;
  const result = state.results[authorId];
  const completed = state.batchIds.filter(
    (id) => state.results[id].status === 'complete',
  ).length;
  const list = (
    <div className="space-y-2">
      {visible.map((a) => (
        <div key={a.id} className="demo-author-row">
          <Checkbox
            aria-label={`选择${a.name}`}
            isDisabled={state.busy}
            isSelected={state.selected.includes(a.id)}
            onValueChange={(checked) =>
              setState((previous) => selectDemoAuthor(previous, a.id, checked))
            }
          />
          <button
            type="button"
            className="demo-author-button"
            aria-pressed={authorId === a.id}
            onClick={() => {
              setAuthorId(a.id);
              setDrawer(false);
            }}
          >
            <strong>{a.name}</strong>
            <span>
              {a.platform === 'wechat' ? '公众号' : '小红书'} · {a.source}
            </span>
            <span>{demoResultMessage(state.results[a.id])}</span>
          </button>
        </div>
      ))}
    </div>
  );
  return (
    <NextUIProvider>
      <main className="demo-shell">
        <header className="demo-header">
          <div>
            <p className="demo-kicker">WeWe · 跨端交互原型</p>
            <h1>自己的图文归档</h1>
          </div>
          <span className="demo-disconnected" role="status">
            本机未连接 · 离线演示
          </span>
        </header>
        <div className="demo-notice">
          所有作者、图文和进度均为虚构示例。这里演示手机与桌面的操作，不代表来源可用、图文已保存或
          Sites 已连接。 小红书真实首轮仍只取一个博主前三篇。
        </div>
        <section className="demo-toolbar" aria-label="手动更新">
          <Button
            className="demo-mobile-list"
            variant="bordered"
            onPress={() => setDrawer(true)}
          >
            订阅列表
          </Button>
          <label>
            平台{' '}
            <select
              aria-label="平台筛选"
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as typeof filter)
              }
            >
              <option value="all">全部平台</option>
              <option value="wechat">公众号</option>
              <option value="xiaohongshu">小红书</option>
            </select>
          </label>
          <Button isDisabled variant="bordered">
            更新全部（未连接）
          </Button>
          <Button
            color="primary"
            isDisabled={state.busy}
            onPress={() => setState(startDemo)}
          >
            演示手动更新
          </Button>
          <Button
            isDisabled={!state.busy || state.cancelRequested}
            variant="flat"
            onPress={() => setState(cancelDemo)}
          >
            {state.cancelRequested ? '等待当前演示结束' : '停止后续演示'}
          </Button>
          <Button
            isDisabled={state.busy}
            variant="light"
            onPress={() => setState(initialDemoState())}
          >
            重置示例
          </Button>
        </section>
        <section className="demo-progress" aria-live="polite">
          <strong>
            {state.busy
              ? '演示批次进行中'
              : state.run
                ? '演示批次已结束'
                : '尚未开始演示'}
          </strong>
          <span>
            示例完成 {completed} · 当前选择 {state.selected.length} 个作者
          </span>
          <p>
            未就绪或待验证的来源保持原状态；停止只影响未开始项。真实更新按钮在未连接时不可用。
          </p>
        </section>
        <div className="demo-grid">
          <aside className="demo-desktop-list" aria-label="订阅列表">
            {list}
          </aside>
          <section className="demo-content">
            <header className="demo-content-header">
              <div>
                <h2>{author.name}</h2>
                <p>
                  {author.platform === 'wechat' ? '公众号' : '小红书'} ·{' '}
                  {author.source}
                </p>
              </div>
            </header>
            <div
              className={`demo-result demo-result-${result.status}`}
              role="status"
            >
              <strong>{demoResultMessage(result)}</strong>
              {result.status === 'running' && (
                <progress
                  aria-label="示例更新进度"
                  max={3}
                  value={result.stage + 1}
                />
              )}
              <p>
                {result.status === 'failed'
                  ? '本次失败不清空此前示例，也不会切换来源或自动重试。'
                  : '完整性、请求覆盖和实际保存需在真实接入后分别验收。'}
              </p>
            </div>
            <article className="demo-item">
              <span className="demo-kicker">虚构缓存 · 仅用于布局预览</span>
              <h3>示例：把今天的一小段日常记下来</h3>
              <p>示例发表日期 2026-10-01 · 段落与两张占位图</p>
              <p>
                这里保留一段本地示例内容，让你在更新失败或来源未就绪时仍能理解“旧内容保留”的阅读体验。
              </p>
              <Button
                size="sm"
                variant="bordered"
                onPress={() => setReading(true)}
              >
                阅读示例全文
              </Button>
              <Button size="sm" isDisabled variant="light">
                下载离线包（待真实归档）
              </Button>
            </article>
          </section>
        </div>
        <footer>
          独立本地原型 · 未创建 Sites · 未连接 wewe-rss-ss 或任何平台
        </footer>
        <Modal
          isOpen={drawer}
          onOpenChange={setDrawer}
          scrollBehavior="inside"
          size="lg"
        >
          <ModalContent>
            <ModalHeader>订阅列表 · 示例</ModalHeader>
            <ModalBody className="pb-5">{list}</ModalBody>
          </ModalContent>
        </Modal>
        <Modal
          isOpen={reading}
          onOpenChange={setReading}
          scrollBehavior="inside"
          size="2xl"
        >
          <ModalContent>
            <ModalHeader>示例全文 · 虚构内容</ModalHeader>
            <ModalBody className="pb-5">
              <p>
                清晨，把窗边的一束光和手边的笔记记下来。这里展示完整阅读区的段落、留白与图片顺序。
              </p>
              <div
                className="demo-picture"
                role="img"
                aria-label="示例占位图一"
              >
                示例图片 01
              </div>
              <p>
                手机上纵向阅读，电脑上可以保留作者列表。两张占位图用于检查图序，不是平台图片或已下载的附件。
              </p>
              <div
                className="demo-picture second"
                role="img"
                aria-label="示例占位图二"
              >
                示例图片 02
              </div>
            </ModalBody>
          </ModalContent>
        </Modal>
      </main>
    </NextUIProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <PaidSubscriptionsPrototype />,
);
