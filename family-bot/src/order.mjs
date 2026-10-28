// Online grocery orders. The bot queues a list the family confirmed; the shopper on the home machine
// (shopper/ beside this project) takes it, fills the cart on the store's site, stops before payment and reports back.
// One order at a time, kept in kv (no new table). A job of kind "scan" only reads the יאמי account (src/yummi.mjs).
const KEY = 'order:job';
const STALE_MS = 3 * 3600_000; // an order that never reported back stops blocking new ones
const ACTIVE = new Set(['queued', 'running', 'needs_human']);

export const STORES = { carrefour: 'קרפור', yummi: 'יאמי' };
const ICON = { carrefour: '🛒', yummi: '🍲' };
// What a יאמי order carries beyond its meals.
const EXTRA = ['cook', 'cook_url', 'address', 'when', 'reorder'];

// entries: list entries (Carrefour), or items: [{ id, text, qty?, note? }] (יאמי meals, which are not kept in a list).
export async function startOrder(db, { chatId, by, store = 'carrefour', kind = 'fill', entries, items, ...extra }, now = Date.now()) {
  if (!STORES[store]) throw new Error(`חנות לא מוכרת: ${store}`);
  items ??= (entries ?? []).map((e) => ({ id: e.id, text: e.text, ...e.fields }));
  if (kind === 'fill' && !items.length) throw new Error('אין פריטים פתוחים להזמנה');
  const old = await db.get(KEY);
  if (old && ACTIVE.has(old.status) && now - old.updated_at < STALE_MS) throw new Error('כבר יש הזמנה בטיפול. חכו שהיא תסתיים.');
  const job = {
    id: now, kind, store, chat_id: chatId, by, status: 'queued', created_at: now, updated_at: now, items,
    ...Object.fromEntries(EXTRA.filter((k) => extra[k] != null).map((k) => [k, extra[k]])),
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
// A scan reports "scanned" (no text here: the Worker keeps the reading and sends the suggestion).
export async function reportOrder(db, r, now = Date.now()) {
  const job = await db.get(KEY);
  if (!job || job.id !== r.id || !ACTIVE.has(job.status)) return null;
  const ok = job.kind === 'scan' ? ['scanned', 'failed'] : ['needs_human', 'running', 'done', 'failed'];
  const status = ok.includes(r.status) ? r.status : 'failed';
  Object.assign(job, { status, updated_at: now });
  await db.set(KEY, job);
  if (status === 'scanned') return { job, text: null };
  return { job, text: job.kind === 'scan' ? `🍲 יאמי: לא הצלחתי לקרוא את ההזמנות בחשבון. ${s(r.text, 300)}` : formatReport(job, { ...r, status }) };
}

const s = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function formatReport(job, r) {
  const store = STORES[job.store];
  const icon = ICON[job.store] ?? '🛒';
  if (r.status === 'needs_human') {
    return `${icon} ${store}: צריך אתכם רגע – ${s(r.text, 300)}` + (r.view_url ? `\nפתחו את הדפדפן של הבוט: ${s(r.view_url)}` : '') +
      '\nאחרי שתסיימו אמשיך לבד.';
  }
  if (r.status === 'running') return `${icon} ${store}: ${s(r.text, 300)}`;
  const added = (r.added ?? []).slice(0, 60).map((a) => `• ${s(a.item, 60)} → ${s(a.product, 80)}${a.qty > 1 ? ` ×${Number(a.qty)}` : ''}`);
  const missing = (r.missing ?? []).slice(0, 60).map((m) => `• ${s(m.item, 60)}${m.reason ? ` (${s(m.reason, 80)})` : ''}`);
  return [
    r.status === 'failed'
      ? `${icon} ${store}: לא הצלחתי להגיע לתשלום. ${s(r.text, 300)}`
      : `${icon} הסל ב${store} מוכן (${added.length} ${job.store === 'yummi' ? 'מנות' : 'מוצרים'})${r.total ? `, סה"כ ${s(r.total, 30)}` : ''}.`,
    r.below_minimum ? `⚠️ ההזמנה מתחת למינימום של האתר. צריך להוסיף עוד ${s(r.below_minimum, 30)} כדי לסיים את הקנייה.` : '',
    r.note && r.status === 'done' ? s(r.note, 300) : '',
    added.length ? `נוסף:\n${added.join('\n')}` : '',
    missing.length ? `לא נמצא / לא נוסף:\n${missing.join('\n')}` : '',
    r.status === 'failed' && added.length ? 'מה שנוסף נשאר בסל באתר.' : '',
    r.checkout_url ? `${r.below_minimum ? 'לסל' : 'לתשלום'} (מחוברים לחשבון המשפחה באתר): ${s(r.checkout_url, 400)}` : '',
    // The יאמי cart may live in the browser session rather than the account: the bot's own browser always has it.
    r.status === 'done' && job.store === 'yummi' && r.view_url ? `אם הסל לא מופיע אצלכם, אפשר לסיים בדפדפן של הבוט: ${s(r.view_url, 300)}` : '',
    r.status === 'done' ? 'לא שילמתי – התשלום אצלכם.' : '',
  ].filter(Boolean).join('\n\n');
}
