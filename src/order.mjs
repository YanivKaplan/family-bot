// Online grocery orders. The bot queues a list the family confirmed; the shopper on the home machine
// (shopper/main.mjs) takes it, fills the cart on the store's site, stops before payment and reports back.
// One order at a time, kept in kv (no new table).
const KEY = 'order:job';
const STALE_MS = 3 * 3600_000; // an order that never reported back stops blocking new ones
const ACTIVE = new Set(['queued', 'running', 'needs_human']);

export const STORES = { carrefour: 'קרפור' };

export async function startOrder(db, { chatId, by, store = 'carrefour', entries }, now = Date.now()) {
  if (!STORES[store]) throw new Error(`חנות לא מוכרת: ${store}`);
  if (!entries.length) throw new Error('אין פריטים פתוחים להזמנה');
  const old = await db.get(KEY);
  if (old && ACTIVE.has(old.status) && now - old.updated_at < STALE_MS) throw new Error('כבר יש הזמנה בטיפול. חכו שהיא תסתיים.');
  const job = {
    id: now, store, chat_id: chatId, by, status: 'queued', created_at: now, updated_at: now,
    items: entries.map((e) => ({ id: e.id, text: e.text, ...e.fields })),
  };
  await db.set(KEY, job);
  return job;
}

// The shopper asks for work: a queued order becomes running and is returned once.
export async function claimOrder(db, now = Date.now()) {
  const job = await db.get(KEY);
  if (job?.status !== 'queued') return null;
  Object.assign(job, { status: 'running', updated_at: now });
  await db.set(KEY, job);
  return job;
}

// A report from the shopper. Returns the job and the message for the family, or null for an unknown job.
export async function reportOrder(db, r, now = Date.now()) {
  const job = await db.get(KEY);
  if (!job || job.id !== r.id || !ACTIVE.has(job.status)) return null;
  const status = ['needs_human', 'running', 'done', 'failed'].includes(r.status) ? r.status : 'failed';
  Object.assign(job, { status, updated_at: now });
  await db.set(KEY, job);
  return { job, text: formatReport(job, r) };
}

const s = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function formatReport(job, r) {
  const store = STORES[job.store];
  if (r.status === 'needs_human') {
    return `🛒 ${store}: צריך אתכם רגע – ${s(r.text, 300)}` + (r.view_url ? `\nפתחו את הדפדפן של הבוט: ${s(r.view_url)}` : '') +
      '\nאחרי שתסיימו אמשיך לבד.';
  }
  if (r.status === 'running') return `🛒 ${store}: ${s(r.text, 300)}`;
  const added = (r.added ?? []).slice(0, 60).map((a) => `• ${s(a.item, 60)} → ${s(a.product, 80)}${a.qty > 1 ? ` ×${Number(a.qty)}` : ''}`);
  const missing = (r.missing ?? []).slice(0, 60).map((m) => `• ${s(m.item, 60)}${m.reason ? ` (${s(m.reason, 80)})` : ''}`);
  return [
    r.status === 'failed'
      ? `🛒 ${store}: לא הצלחתי להגיע לתשלום. ${s(r.text, 300)}`
      : `🛒 הסל ב${store} מוכן (${added.length} מוצרים)${r.total ? `, סה"כ ${s(r.total, 30)}` : ''}.`,
    added.length ? `נוסף:\n${added.join('\n')}` : '',
    missing.length ? `לא נמצא / לא נוסף:\n${missing.join('\n')}` : '',
    r.status === 'failed' && added.length ? 'מה שנוסף נשאר בסל באתר.' : '',
    r.checkout_url ? `לתשלום (מחוברים לחשבון המשפחה באתר): ${s(r.checkout_url, 400)}` : '',
    r.status === 'done' ? 'לא שילמתי – התשלום אצלכם.' : '',
  ].filter(Boolean).join('\n\n');
}
