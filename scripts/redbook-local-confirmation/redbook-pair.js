'use strict';
(() => {
  let proof = null,
    token = null,
    expiresAt = 0,
    pairing = false,
    busy = false;
  const get = (id) => document.getElementById(id);
  const message = (text) => {
    get('message').textContent = text;
  };
  const clear = () => {
    token = null;
    proof = null;
    expiresAt = 0;
    get('diagnostic').disabled = true;
    get('preview').textContent = '';
    get('pictures').replaceChildren();
    get('a1').value = '';
    get('webSession').value = '';
    get('comparison').textContent = '';
    get('expiry').textContent = '';
    get('pairStatus').textContent = '需要在本机窗口重新确认。';
  };
  const random = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  };
  async function request(path, body, authenticated = false) {
    if (authenticated && (!token || Date.now() >= expiresAt)) {
      clear();
      throw Error('24小时访问已失效，请在启动窗口输入 R 后重新确认。');
    }
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated
          ? {
              Authorization: 'Bearer ' + token,
              'X-Redbook-Browser-Proof': proof,
            }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const value = await response.json();
    if (!response.ok) {
      if (
        authenticated &&
        (response.status === 403 || value.code === 'CLEANUP_FAILED')
      )
        clear();
      const error = Error(
        '操作未完成：' +
          (value.code || '本机确认或预算不可用') +
          '。不会自动重试。',
      );
      error.cleanupFailed = value.code === 'CLEANUP_FAILED';
      throw error;
    }
    return { status: response.status, value };
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    get('diagnostic').disabled = true;
    message('');
    try {
      await action();
    } catch (error) {
      message(
        error.cleanupFailed
          ? '浏览器访问已撤销，会话清理未确认；请在启动窗口输入 R 重试清理或 Q 停止实例。'
          : '操作未完成。请读取本机状态；预算用尽或确认过期时，先在启动窗口输入 R 重新确认。不会自动请求平台。',
      );
    } finally {
      busy = false;
      get('diagnostic').disabled = !token || Date.now() >= expiresAt;
    }
  }
  const diag = async (action, body = {}) =>
    (await request('/diagnostic/' + action, body, true)).value;
  const display = (value) => {
    get('preview').textContent = JSON.stringify(value, null, 2);
    get('pictures').replaceChildren();
    for (const image of value.data?.images || []) {
      if (
        typeof image.inlineData === 'string' &&
        /^data:image\/(png|jpeg|gif|webp);base64,/.test(image.inlineData)
      ) {
        const img = document.createElement('img');
        img.src = image.inlineData;
        img.alt = '待核验图片 ' + image.ordinal;
        get('pictures').append(img);
      }
    }
  };
  get('pair').onclick = async () => {
    if (pairing || busy) return;
    pairing = true;
    get('pair').disabled = true;
    clear();
    proof = random();
    try {
      const start = (await request('/pair/start', { proof })).value;
      get('comparison').textContent = '核对码：' + start.comparison;
      get('pairStatus').textContent =
        '请核对这个页面，在本机启动窗口输入同一码。未确认前不会发放凭证。';
      while (Date.now() < start.pairDeadline) {
        const result = await request('/pair/redeem', {
          pairId: start.pairId,
          proof,
        });
        if (result.status === 200) {
          token = result.value.token;
          expiresAt = result.value.expiresAt;
          get('diagnostic').disabled = false;
          get('comparison').textContent = '';
          get('pairStatus').textContent = '当前浏览器已确认，仅允许小量诊断。';
          get('expiry').textContent =
            '绝对过期时间：' + new Date(expiresAt).toLocaleString();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw Error('确认码已过期');
    } catch {
      clear();
      message('未完成本机确认。请在启动窗口输入 R，再点击请求确认。');
    } finally {
      pairing = false;
      get('pair').disabled = false;
    }
  };
  get('creatorForm').onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      display(
        await diag('creator', {
          displayName: get('name').value,
          profileUrl: get('profile').value,
        }),
      );
      message('仅保存了待核验博主，未请求平台。');
    });
  };
  get('sessionForm').onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      try {
        display(
          await diag('session', {
            cookies: {
              a1: get('a1').value,
              web_session: get('webSession').value,
            },
            expiresAt: expiresAt,
            confirmLocalSession: true,
          }),
        );
        message(
          '小红书会话仅在内存保留至本次24小时绝对期限；未发送平台请求，平台提前失效即停止。',
        );
      } finally {
        get('a1').value = '';
        get('webSession').value = '';
      }
    });
  };
  get('status').onclick = () =>
    void run(async () => display(await diag('status')));
  get('list').onclick = () =>
    void run(async () => {
      const value = await diag('list', { confirmRequest: true });
      display(value);
      get('note').replaceChildren();
      for (const note of value.data?.notes || []) {
        const option = document.createElement('option');
        option.value = note.noteId;
        option.textContent = note.noteId;
        get('note').append(option);
      }
    });
  get('detail').onclick = () =>
    void run(async () => {
      await diag('detail', { confirmRequest: true, noteId: get('note').value });
      display(await diag('sample'));
    });
  get('images').onclick = () =>
    void run(async () => {
      if (!get('allowImages').checked) throw Error('单独确认图片');
      await diag('images', {
        confirmImages: true,
        maxImages: Number(get('imageCount').value),
        maxBytes: 1000000,
      });
      display(await diag('sample'));
    });
  get('sample').onclick = () =>
    void run(async () => display(await diag('sample')));
  get('discard').onclick = () =>
    void run(async () => {
      await diag('discard');
      clear();
      message('浏览器访问确认与小红书会话已撤销。');
    });
  setInterval(() => {
    if (token && Date.now() >= expiresAt) {
      clear();
      message('24小时绝对期限已到，请在本机窗口重新确认。');
    }
  }, 1000);
})();
