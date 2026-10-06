import {
  runTask,
  prepareTask,
  cancelPreparedTask,
  taskDisclosure,
  localEndpoint,
} from './task-client.mjs';
import { probeOfficialArticle } from './probe.mjs';

/** Enumerate only probe booleans and bounded counts. Never dump the result or
 * fingerprints; absent early-return fields are unknown, not negative evidence.
 */
export function formatProbeSummary(result) {
  const value =
    result && typeof result === 'object' && !Array.isArray(result)
      ? result
      : {};
  const flag = (key, yes = '是', no = '否') =>
    value[key] === true ? yes : value[key] === false ? no : '未核实';
  const countValue = (object, key) => {
    const number = object?.[key];
    return Number.isSafeInteger(number) && number >= 0 && number <= 10000
      ? number
      : undefined;
  };
  const count = (object, key) => countValue(object, key) ?? '未核实';
  const fingerprintPresent = (key) => {
    const body = value[key];
    if (body === null) return false;
    return typeof body?.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(body.sha256)
      ? true
      : undefined;
  };
  const fingerprint = (key) => {
    const present = fingerprintPresent(key);
    return present === true ? '存在' : present === false ? '未提供' : '未核实';
  };
  const kinds = value.imageKinds;
  const counts = ['data', 'blob', 'exactCdn', 'other'].map((key) =>
    countValue(kinds, key),
  );
  const total = counts.every((number) => number !== undefined)
    ? counts.reduce((sum, number) => sum + number, 0)
    : undefined;
  const unloaded = countValue(kinds, 'notLoaded');
  const loaded =
    total !== undefined &&
    total <= 10000 &&
    unloaded !== undefined &&
    unloaded <= total
      ? `${total - unloaded}/${total}`
      : '未核实';
  const consistency =
    fingerprintPresent('rawBody') === true &&
    fingerprintPresent('domBody') === true &&
    typeof value.bodyProjectionMatched === 'boolean'
      ? `DOM与已返回正文${value.bodyProjectionMatched ? '一致' : '不一致'}`
      : 'DOM与已返回正文：未核实';
  return [
    '只读核验摘要（不回送）',
    `当前上下文契约：${flag('supported', '满足', '尚未满足')}`,
    `根Vue属性：${flag('vuePropertyPresent', '存在', '不存在')}；实例值：${flag('vueValuePresent', '存在', '不存在')}`,
    `组件选项：${flag('optionsPresent', '存在', '不存在')}；名称字段：${flag('namePresent', '存在', '不存在')}`,
    `显示业务字段定义（号/章/正文）：${flag('displayedBookFieldDefined')}/${flag('displayedChapterFieldDefined')}/${flag('displayedBodyFieldDefined')}（只查属性是否定义，不读值）`,
    `组件匹配：${flag('componentMatched', '匹配', '未匹配')}；iframe可读：${flag('frameReadable')}`,
    ...(countValue(value, 'rootCount') !== undefined ||
    countValue(value, 'frameCount') !== undefined
      ? [
          `已返回根/iframe数量：${count(value, 'rootCount')}/${count(value, 'frameCount')}`,
        ]
      : []),
    `号身份字段：${flag('bookIdPresent', '存在', '不存在')}；文章身份字段：${flag('reviewIdPresent', '存在', '不存在')}；原文身份字段：${flag('originalIdPresent', '存在', '不存在')}`,
    `文章业务关联：${flag('reviewBindingMatched', '匹配', '未匹配')}；公众号业务关联：${flag('publisherBindingMatched', '匹配', '未匹配')}`,
    `标题匹配：${flag('titleMatched', '匹配', '未匹配')}；来源名称匹配：${flag('publisherMatched', '匹配', '未匹配')}`,
    `静态身份字段：${flag('identityScalarsPresent', '存在', '不存在')}；发布时间字段：${flag('creationTimePresent', '存在', '不存在')}；canonical字段：${flag('canonicalPresent', '存在', '不存在')}（只看存在性）`,
    `加载结束：${flag('notLoading')}；无页面错误：${flag('notError')}；无禁止标志：${flag('notForbidden')}`,
    `已返回正文指纹：${fingerprint('rawBody')}；DOM指纹：${fingerprint('domBody')}（不显示指纹值）`,
    consistency,
    `正文图片数量（已返回/DOM）：${count(value.rawBody, 'images')}/${count(value.domBody, 'images')}`,
    `图片类别：data ${count(kinds, 'data')}；blob ${count(kinds, 'blob')}；指定CDN ${count(kinds, 'exactCdn')}；其他 ${count(kinds, 'other')}`,
    `图片显示已加载/总数：${loaded}；未加载：${count(kinds, 'notLoaded')}`,
    '上游全篇完整性：未证明；正文指纹匹配仅说明DOM与已返回正文一致。',
    '图片加载仅说明显示状态；原始图片字节与完整保存：本轮未验证。',
    '本次只读核验未联网或自动重试；回送仍未启用。可选中此摘要反馈。',
  ].join('\n');
}

export function bindPopup(document, chrome, fetch) {
  document.querySelector('#probe').addEventListener('click', async () => {
    const button = document.querySelector('#probe');
    const status = document.querySelector('#status');
    const summary = document.querySelector('#probe-summary');
    if (button.disabled) return;
    button.disabled = true;
    summary.textContent = '正在执行本次只读核验；不会自动重试。';
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (new URL(tab?.url || '').origin !== 'https://weread.qq.com')
        throw new Error('SOURCE_TAB');
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: probeOfficialArticle,
      });
      const result =
        results.length === 1 && results[0].frameId === 0
          ? results[0].result
          : null;
      summary.textContent = formatProbeSummary(result);
      status.textContent = '本次只读核验结束。请查看逐项摘要；回送仍未启用。';
    } catch {
      summary.textContent = formatProbeSummary(null);
      status.textContent = '本次只读核验未取得结果；未自动重试，回送仍未启用。';
    } finally {
      button.disabled = false;
    }
  });
  bindTaskControls(document, chrome, fetch);
}

/** Only click handlers request/remove permissions. No startup grant, body read,
 * network or persisted pairing. Server disclosure precedes explicit body consent. */
export function bindTaskControls(document, chrome, fetch) {
  const $ = (selector) => document.querySelector(selector);
  if (!$('#grant')) return; // Probe-only harness has no task controls.
  let busy = false,
    terminal = false,
    prepared,
    controller,
    received = false,
    revoked = false,
    permissionPending = false;
  const status = $('#status'),
    review = $('#task-review');
  const input = () => {
    const base = localEndpoint($('#base').value),
      key = $('#key').value,
      taskId = $('#taskId').value;
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !/^[a-f0-9-]{36}$/.test(taskId))
      throw new Error('PAIRING_INPUT');
    return { chrome, fetch, base, key, taskId };
  };
  const controls = () => {
    $('#grant').disabled = busy || terminal || !!prepared;
    $('#prepare').disabled = busy || terminal || !!prepared;
    $('#send').disabled =
      busy || terminal || !prepared || !$('#content-consent').checked;
    $('#content-consent').disabled = busy || terminal || !prepared;
    $('#cancel').disabled = terminal || (!busy && !prepared);
    $('#key').disabled = busy || !!prepared;
    $('#taskId').disabled = busy || !!prepared;
  };
  const stop = async () => {
    terminal = true;
    controller?.abort();
    $('#content-consent').checked = false;
    controls();
    const cancelled = await cancelPreparedTask(prepared);
    $('#key').value = '';
    status.textContent = received
      ? '回送已接收；请在原 WeWe 取消尚未保存的任务。已保存文件不会自动删除。'
      : cancelled
        ? '本窗口已取消后续回送，不再读取或发送。服务器可能已接收正文，请在原 WeWe 核对并取消尚未保存的任务。'
        : '已停止本窗口后续操作；请在原 WeWe 核对并取消等待任务，关闭弹窗不等于取消。';
  };
  $('#content-consent').addEventListener('change', controls);
  $('#grant').addEventListener('click', async () => {
    if (busy || terminal || prepared) return;
    try {
      input();
      if (!$('#permission-consent').checked)
        throw new Error('CONSENT_REQUIRED');
      busy = true;
      controls();
      // Must be invoked directly during this user gesture, before awaiting anything.
      permissionPending = true;
      const request = chrome.permissions.request({
        origins: ['http://127.0.0.1/*', 'https://mmbiz.qpic.cn/*'],
      });
      const granted = await request;
      if (revoked && granted) {
        const removed = await chrome.permissions.remove({
          origins: ['http://127.0.0.1/*', 'https://mmbiz.qpic.cn/*'],
        });
        status.textContent = removed
          ? '迟到的授权已撤销；本次停止，不再读取或传输。'
          : '本次已停止；迟到的授权撤销未确认，请到扩展设置核对。';
      }
      if (!terminal)
        status.textContent = granted
          ? '权限已授予，尚未读取或回送正文。请领取本机任务说明。'
          : '授权已拒绝；没有读取或回送正文。';
    } catch {
      if (revoked)
        status.textContent = '本次已停止；权限撤销未确认，请到扩展设置核对。';
      else if (!terminal)
        status.textContent =
          '请核对本机4000端口、任务配置及权限勾选；没有读取正文。';
    } finally {
      permissionPending = false;
      busy = false;
      controls();
    }
  });
  $('#prepare').addEventListener('click', async () => {
    if (busy || terminal || prepared) return;
    busy = true;
    controller = new AbortController();
    controls();
    try {
      prepared = await prepareTask({ ...input(), signal: controller.signal });
      if (terminal) {
        await cancelPreparedTask(prepared);
        return;
      }
      const d = taskDisclosure(prepared);
      review.textContent = `本次文章：${d.title}\n公众号：${d.publisher}\n实际原图：${d.imageCount}张\n本机接收：http://127.0.0.1:4000\n原保存目录：${d.destination}\n传输：清理正文、公开身份和原图字节；不含网站凭据。\n截止：${prepared.claim.expiresAt}\n接收不等于保存成功，请在原 WeWe 查看保存结果。`;
      status.textContent =
        '已领取本次任务说明，尚未读取正文。请核对后勾选回送。';
    } catch {
      if (!terminal) {
        terminal = true;
        await cancelPreparedTask(prepared);
        status.textContent =
          '未取得有效的一次任务说明；未读取正文。请查看原 WeWe，勿自动重试或重复验证。';
      }
    } finally {
      busy = false;
      controls();
    }
  });
  $('#task').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || terminal || !prepared || !$('#content-consent').checked) return;
    busy = true;
    controls();
    try {
      await runTask({ chrome, fetch, prepared });
      if (!terminal) {
        received = true;
        terminal = true;
        status.textContent =
          '本机已接收并核验；扩展不能确认保存。请查看原 WeWe 保存结果。';
      }
    } catch {
      if (!terminal) {
        terminal = true;
        status.textContent =
          '回送未完成；请核对原 WeWe 任务状态。没有自动重试。';
      }
    } finally {
      busy = false;
      $('#key').value = '';
      controls();
    }
  });
  $('#cancel').addEventListener('click', async () => {
    if (!terminal) await stop();
  });
  $('#revoke').addEventListener('click', async () => {
    revoked = true;
    await stop();
    try {
      const removed = await chrome.permissions.remove({
        origins: ['http://127.0.0.1/*', 'https://mmbiz.qpic.cn/*'],
      });
      status.textContent += permissionPending
        ? ' 授权弹窗尚未结束；若迟到授权成功，会再次撤销。'
        : removed
          ? ' 已撤销本机和原图权限。'
          : ' 权限撤销未确认，请在扩展设置核对。';
    } catch {
      status.textContent += ' 权限撤销未确认，请在扩展设置核对。';
    }
  });
  controls();
  void chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      const url = new URL(tab?.url || '');
      $('#current-tab').textContent =
        url.origin === 'https://weread.qq.com' &&
        /^\/web\/mp\/reader\//.test(url.pathname)
          ? `当前官方标签页：${tab.title || '公众号阅读页'}（最终以本机任务固定文章核对）`
          : '当前不是官方公众号文章页；不能回送。';
    })
    .catch(() => {
      $('#current-tab').textContent = '当前标签页无法核对；不能据此确认文章。';
    });
}

if (typeof document !== 'undefined') bindPopup(document, chrome, fetch);
