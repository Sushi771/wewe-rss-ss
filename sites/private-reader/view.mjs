import { statusCopy } from './reader-model.mjs';

/** Only DOM text nodes and validated data images; cached HTML is never mounted. */
export function mountReader({ document, root, controller, saveDownload }) {
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (label, action, disabled = false) => {
    const node = element('button', label);
    node.type = 'button';
    node.disabled = disabled;
    node.addEventListener('click', action);
    return node;
  };
  const render = (state) => {
    const busy = state.status === 'loading';
    const shell = element('div', undefined, 'reader');
    const header = element('header');
    header.append(
      element('p', 'WEWE RSS / 私人阅读', 'eyebrow'),
      element('h1', '我的订阅'),
      element('p', '查看本机已缓存的图文，下载到正在使用的设备。', 'muted'),
    );
    const nav = element('nav');
    nav.setAttribute('aria-label', '订阅来源');
    for (const [platform, label] of [
      ['wechat', '公众号'],
      ['xiaohongshu', '小红书'],
    ]) {
      const tab = button(label, () => controller.loadAuthors(platform));
      tab.setAttribute('aria-pressed', String(state.platform === platform));
      nav.append(tab);
    }
    header.append(nav);
    shell.append(header);
    const notice = element(
      'p',
      busy
        ? '正在读取缓存…'
        : statusCopy[state.status] ||
            (state.status === 'empty' ? '当前范围没有缓存内容。' : ''),
    );
    notice.setAttribute('role', statusCopy[state.status] ? 'alert' : 'status');
    notice.setAttribute('aria-live', 'polite');
    shell.append(notice);
    if (state.status === 'sign-in') {
      const signIn = element('a', '使用本人账号登录');
      signIn.href = '/signin-with-chatgpt';
      signIn.target = '_top';
      shell.append(signIn);
    }
    if (statusCopy[state.status] && state.status !== 'forbidden')
      shell.append(button('重新读取订阅', () => controller.loadAuthors()));
    const columns = element('div', undefined, 'columns');
    const subscriptions = element('section', undefined, 'panel');
    subscriptions.append(element('h2', '订阅'));
    const authors = element('ul', undefined, 'choices');
    for (const author of state.authors) {
      const row = element('li');
      const select = button(
        author.name,
        () => controller.openAuthor(author.id),
        busy,
      );
      select.setAttribute(
        'aria-current',
        String(author.id === state.author?.id),
      );
      row.append(select);
      authors.append(row);
    }
    subscriptions.append(
      authors,
      button(
        '下一页订阅',
        () => controller.nextAuthors(),
        busy || !state.nextAuthors,
      ),
    );
    const content = element('section', undefined, 'panel content');
    content.append(element('h2', state.author?.name || '文章'));
    const articles = element('ul', undefined, 'choices');
    for (const item of state.items) {
      const row = element('li');
      row.append(button(item.title, () => controller.openItem(item.id), busy));
      articles.append(row);
    }
    content.append(
      articles,
      button(
        '下一页文章',
        () => controller.nextItems(),
        busy || !state.nextItems,
      ),
    );
    if (state.truncated)
      content.append(element('p', '仅展示本次返回范围。', 'muted'));
    if (state.body) {
      const article = element('article');
      article.append(element('h2', state.body.title));
      const date = new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'long',
        timeZone: 'Asia/Shanghai',
      }).format(new Date(state.body.publishTime * 1000));
      article.append(element('p', date, 'muted'));
      for (const paragraph of state.body.text.split('\n'))
        article.append(element('p', paragraph));
      for (const source of state.body.images) {
        const image = element('img');
        image.src = source;
        image.alt = '已缓存的文章图片';
        image.loading = 'lazy';
        article.append(image);
      }
      article.append(
        button(
          '下载到当前设备',
          async () => {
            const download = await controller.download();
            if (download) saveDownload(download);
          },
          busy,
        ),
      );
      content.append(article);
    }
    columns.append(subscriptions, content);
    shell.append(
      columns,
      element(
        'footer',
        '电脑离线时无法读取本机内容。本界面不提交刷新任务。',
        'muted',
      ),
    );
    root.replaceChildren(shell);
  };
  return { render };
}
