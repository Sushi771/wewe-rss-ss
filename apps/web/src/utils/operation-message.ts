export function operationDiagnostic(error: unknown) {
  return error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : String(error ?? '');
}

export function failureMessage(
  error: unknown,
  fallback = '操作未完成，请先查看状态和详情。',
) {
  const raw = operationDiagnostic(error);
  if (raw.includes('XHS_SOURCE_HISTORY_REVIEW_REQUIRED'))
    return '历史来源请求结果尚需核对，新增订阅暂未开始。请先查看来源状态和历史采集任务。';
  if (raw.includes('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'))
    return '来源 API 拒绝了请求，原因尚不明确；采集已停止。网页可访问不代表此接口可用，请先核查来源状态。';
  if (raw.includes('XHS_SOURCE_VERIFICATION_BLOCKED'))
    return '来源明确提示需要验证，但当前没有可确认的验证入口；采集已停止，请先核查来源状态。';

  if (/401|UNAUTHORIZED|无权限|未登录|登录.*过期/.test(raw))
    return '登录已失效或无权操作，请检查账号。';
  if (/403|FORBIDDEN|权限|授权/.test(raw))
    return '当前账号无权执行此操作，请检查授权。';
  if (/SQLITE_FULL|SPACE_BUDGET|DISK_SPACE|空间不足|磁盘.*不足/.test(raw))
    return '存储空间不足，操作已暂停，请检查存储与备份。';
  if (/验证|验证码|captcha/i.test(raw))
    return '需要完成官方验证，当前操作已暂停。';
  if (/频控|频率|限流|429/.test(raw))
    return '请求过于频繁，已暂停，请稍后再试。';
  if (/分组名称|名称.*字符/.test(raw))
    return '名称须为 1–80 个字符，不能包含控制字符。';
  if (/已保存\s*\d+.*(未保存|失败)/.test(raw)) return raw;
  if (/一致性|身份.*不一致|数据检查|备份.*失败/.test(raw))
    return '数据检查未通过，操作未完成，请查看详情后处理。';
  if (/回执|未收到有效|结果.*未确认/.test(raw))
    return '操作结果尚未确认，请先检查任务状态和已保存内容，避免重复操作。';
  if (/目录.*不存在|路径.*不存在/.test(raw))
    return '保存目录不存在，请重新选择目录。';
  if (/文件夹.*(非空|仍有|不为空)/.test(raw))
    return '文件夹中仍有订阅，请先移出再删除。';
  if (/链接.*(无效|不支持)|请输入.*链接/.test(raw))
    return '链接无效或暂不支持，请检查后重新输入。';
  return fallback;
}
