import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

/** Opt-in recovery of one missed daily cache read, never a supplier update. */
export function dailyWechat2RssCatchup(
  env: NodeJS.ProcessEnv,
  now = Date.now(),
) {
  if (
    env.WECHAT2RSS_DAILY_CATCHUP !== '1' ||
    env.ENABLE_SCHEDULED_UPDATES !== '1' ||
    env.DISABLE_SCHEDULED_UPDATES === '1' ||
    env.WECHAT2RSS_ENABLED !== '1' ||
    !Number.isFinite(now)
  )
    return;
  // Recovery is limited to one explicitly selected subscription.
  const id = env.SCHEDULED_MP_IDS?.trim();
  if (!id || !/^MP_WXS_\d{5,15}$/.test(id)) return;
  const match = env.CRON_EXPRESSION?.trim().match(
    /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/,
  );
  if (!match) return;
  const minute = Number(match[1]),
    hour = Number(match[2]);
  if (minute > 59 || hour > 23) return;
  const instant = dayjs(now);
  if (!instant.isValid()) return;
  const current = instant.tz('Asia/Shanghai');
  let due = current.startOf('day').hour(hour).minute(minute);
  if (due.valueOf() > now) due = due.subtract(1, 'day');
  return { id, dueTime: due.unix() };
}
