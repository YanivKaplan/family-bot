// Fixed Hebrew texts for commands and the daily summary (no model call, no cost).
import { formatHe, localDate } from './time.mjs';

export const HELP = `שלום! אני עוזר הבית 🏠
אפשר לכתוב לי בשפה חופשית. בקבוצה: התחילו ב"בוט" או תייגו אותי, או השיבו להודעה שלי.

דוגמאות:
• בוט, תוסיף חלב, ביצים ו-2 לחם
• בוט, קניתי את החלב
• בוט, משימה: להחליף את הנעליים של נועה, בקניון, עד יום חמישי
• בוט, תפתח רשימת ציוד לתינוק: עגלה, סלקל, אמבטיה
• בוט, תעביר את החיתולים לפארם / תמחק את העגלה / תשנה ל-3 חבילות
• בוט, תזכיר לנו מחר ב-8 בערב להוציא את הפח
• בוט, תזכיר כל יום ראשון ב-7 לשים זבל למחזור
• בוט, אנחנו בקניון, מה אפשר לעשות פה?
• בוט, תזכור שהתקציב החודשי שלנו לאוכל הוא 3,000 ₪
• בוט, בוא נחשוב איך לצמצם הוצאות החודש
• בוט, תעזור לתכנן ארוחות לשבוע
• בוט, עד מתי הדואר פתוח היום?
• שיתוף מיקום חי בקבוצה: כשתגיעו למקום שמור, אגיד מה אפשר לעשות שם

פקודות: /list כל הרשימות, /reminders תזכורות`;

// Any list. Known fields get a short form; any other field is shown as "key: value".
const SHORT = new Set(['qty', 'note', 'assignee', 'due', 'places']);
export function formatEntry(e, today) {
  const f = e.fields ?? {};
  const parts = [`• ${e.text}`];
  if (f.qty != null) parts.push(`× ${f.qty}`);
  if (f.assignee) parts.push(`(${f.assignee})`);
  if (f.due) parts.push(`– ${today && f.due.slice(0, 10) < today ? '⚠️ ' : ''}${f.due.replace('T', ' ')}`);
  if (f.places?.length) parts.push(`📍 ${[].concat(f.places).join(', ')}`);
  if (f.note) parts.push(`(${f.note})`);
  for (const [k, v] of Object.entries(f)) if (!SHORT.has(k)) parts.push(`${k}: ${[].concat(v).join(', ')}`);
  return parts.join(' ');
}

export function formatLists(entries, tz, now = Date.now()) {
  if (!entries.length) return 'כל הרשימות ריקות 🎉';
  const today = localDate(new Date(now), tz);
  const byList = new Map();
  for (const e of entries) {
    if (!byList.has(e.list)) byList.set(e.list, []);
    byList.get(e.list).push(e);
  }
  return [...byList].map(([list, es]) => `📋 ${list}:\n` + es.map((e) => formatEntry(e, today)).join('\n')).join('\n\n');
}

export function formatReminders(rs, tz) {
  if (!rs.length) return 'אין תזכורות פעילות.';
  const rep = { daily: 'כל יום', weekly: 'כל שבוע', monthly: 'כל חודש', yearly: 'כל שנה' };
  return '⏰ תזכורות:\n' + rs.map((r) => `• ${r.text} – ${formatHe(r.next_at, tz)}${r.rule ? ` (${rep[r.rule.freq] ?? 'חוזרת'})` : ''}`).join('\n');
}

// Morning summary: list entries due today or overdue, reminders today, and the open count.
export function formatDigest({ entries, reminders }, tz, now = Date.now()) {
  const today = localDate(new Date(now), tz);
  const dueToday = entries.filter((e) => e.fields?.due && e.fields.due.slice(0, 10) <= today);
  const remToday = reminders.filter((r) => localDate(new Date(r.next_at), tz) === today);
  if (!dueToday.length && !remToday.length) return null;
  const lines = ['☀️ בוקר טוב! להיום:'];
  for (const e of dueToday) lines.push(`• ${e.text}${e.fields.assignee ? ` (${e.fields.assignee})` : ''}${e.fields.due.slice(0, 10) < today ? ' ⚠️ באיחור' : ''}`);
  for (const r of remToday) lines.push(`• ⏰ ${formatHe(r.next_at, tz).split(' ').at(-1)} ${r.text}`);
  if (entries.length) lines.push(`📋 ברשימות: ${entries.length} פריטים פתוחים`);
  return lines.join('\n');
}
