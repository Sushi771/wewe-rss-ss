import { runTask } from './task-client.mjs';
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
    '只读核验摘要（0.1.2；不回送）',
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
  document.querySelector('#task').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.querySelector('#task button');
    const status = document.querySelector('#status');
    button.disabled = true;
    try {
      // Permissions are deliberately never requested by this candidate. A future
      // install/permission review must precede enabling communication.
      await runTask({
        chrome,
        fetch,
        base: document.querySelector('#base').value,
        key: document.querySelector('#key').value,
        taskId: document.querySelector('#taskId').value,
      });
      status.textContent = '本机已接收并核验；保存结果请查看原 WeWe 任务。';
    } catch {
      status.textContent =
        '任务未完成。请查看本机任务状态；不要重复验证码或切换账号。';
    } finally {
      document.querySelector('#key').value = '';
      button.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') bindPopup(document, chrome, fetch);
