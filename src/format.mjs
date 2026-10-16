// Fixed Hebrew texts for commands and the daily summary (no model call, no cost).
import { formatHe, localDate } from './time.mjs';

export const HELP = `שלום! אני עוזר הבית 🏠
אפשר לכתוב לי בשפה חופשית. בקבוצה: התחילו ב"בוט" או תייגו אותי, או השיבו להודעה שלי.

דוגמאות:
• בוט, תוסיף חלב, ביצים ו-2 לחם
• בוט, קניתי את החלב
• בוט, משימה: להחליף את הנעליים של נועה, בקניון
• בוט, תזכיר לנו מחר ב-8 בערב להוציא את הפח
• בוט, תזכיר כל יום ראשון ב-7 לשים זבל למחזור
• בוט, אנחנו בקניון, מה אפשר לעשות פה?
• בוט, תזכור שהתקציב החודשי שלנו לאוכל הוא 3,000 ₪
• בוט, בוא נחשוב איך לצמצם הוצאות החודש
• בוט, תעזור לתכנן ארוחות לשבוע
• בוט, עד מתי הדואר פתוח היום?
• שיתוף מיקום חי בקבוצה: כשתגיעו למקום שמור, אגיד מה אפשר לעשות שם

פקודות: /list קניות, /tasks משימות, /reminders תזכורות`;

export function formatShopping(items) {
  if (!items.length) return 'רשימת הקניות ריקה 🎉';
  const byList = new Map();
  for (const it of items) {
    if (!byList.has(it.list)) byList.set(it.list, []);
    byList.get(it.list).push(it);
  }
  return [...byList.entries()]
    .map(([list, its]) => `🛒 ${list}:\n` + its.map((i) => `• ${i.name}${i.qty ? ` × ${i.qty}` : ''}${i.note ? ` (${i.note})` : ''}`).join('\n'))
    .join('\n\n');
}

export function formatTasks(tasks, tz, now = Date.now()) {
  if (!tasks.length) return 'אין משימות פתוחות 👌';
  return '📋 משימות:\n' + tasks.map((t) => {
    const parts = [`• ${t.title}`];
    if (t.assignee) parts.push(`(${t.assignee})`);
    if (t.due_at) parts.push(`– ${t.due_at < now ? '⚠️ ' : ''}${formatHe(t.due_at, tz, { withTime: !!t.due_has_time })}`);
    if (t.places) parts.push(`📍 ${t.places.split(',').join(', ')}`);
    return parts.join(' ');
  }).join('\n');
}

export function formatReminders(rs, tz) {
  if (!rs.length) return 'אין תזכורות פעילות.';
  const rep = { daily: 'כל יום', weekly: 'כל שבוע', monthly: 'כל חודש', yearly: 'כל שנה' };
  return '⏰ תזכורות:\n' + rs.map((r) => `• ${r.text} – ${formatHe(r.next_at, tz)}${r.rule ? ` (${rep[r.rule.freq] ?? 'חוזרת'})` : ''}`).join('\n');
}

// Morning summary: tasks due today or overdue, reminders today, and the shopping count.
export function formatDigest({ tasks, reminders, items }, tz, now = Date.now()) {
  const today = localDate(new Date(now), tz);
  const dueToday = tasks.filter((t) => t.due_at && localDate(new Date(t.due_at), tz) <= today);
  const remToday = reminders.filter((r) => localDate(new Date(r.next_at), tz) === today);
  if (!dueToday.length && !remToday.length) return null;
  const lines = ['☀️ בוקר טוב! להיום:'];
  for (const t of dueToday) lines.push(`• ${t.title}${t.assignee ? ` (${t.assignee})` : ''}${t.due_at < now && localDate(new Date(t.due_at), tz) < today ? ' ⚠️ באיחור' : ''}`);
  for (const r of remToday) lines.push(`• ⏰ ${formatHe(r.next_at, tz).split(' ').at(-1)} ${r.text}`);
  if (items.length) lines.push(`🛒 ברשימת הקניות: ${items.length} פריטים`);
  return lines.join('\n');
}
