import { runTask } from './task-client.mjs';
import { probeOfficialArticle } from './probe.mjs';

document.querySelector('#probe').addEventListener('click', async () => {
  const button = document.querySelector('#probe');
  const status = document.querySelector('#status');
  button.disabled = true;
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
    const required = [
      'supported',
      'reviewBindingMatched',
      'publisherBindingMatched',
      'titleMatched',
      'publisherMatched',
      'creationTimePresent',
      'identityScalarsPresent',
      'canonicalPresent',
      'notLoading',
      'notError',
      'notForbidden',
      'bodyProjectionMatched',
    ];
    status.textContent =
      result && required.every((key) => result[key] === true)
        ? '当前关联字段核验通过，仍须核正文完整性及实际图片；未启用回送。'
        : '当前关联字段尚未全部核实，回送仍未启用。';
  } catch {
    status.textContent = '当前页面只读核验未通过，回送仍未启用。';
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
