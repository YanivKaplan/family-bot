// Time zone helpers with no dependencies. All "local" values are in the
// household time zone (default Asia/Jerusalem). The DB stores UTC milliseconds.

const pad = (n) => String(n).padStart(2, '0');

export function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, weekday };
}

// "YYYY-MM-DD"
export const localDate = (date, tz) => {
  const p = localParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};

// "YYYY-MM-DDTHH:MM"
export const localDateTime = (date, tz) => {
  const p = localParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
};

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;

export function parseLocal(s) {
  const m = LOCAL_RE.exec(String(s ?? '').trim());
  if (!m) throw new Error(`תאריך לא תקין: "${s}" (צריך YYYY-MM-DD או YYYY-MM-DDTHH:MM)`);
  const [, y, mo, d, hh = '09', mm = '00'] = m;
  const v = { y: +y, m: +mo, d: +d, hh: +hh, mm: +mm };
  if (v.m < 1 || v.m > 12 || v.d < 1 || v.d > 31 || v.hh > 23 || v.mm > 59) throw new Error(`תאריך לא תקין: "${s}"`);
  return { ...v, hasTime: m[4] !== undefined };
}

// Local wall-clock time -> UTC ms. Two passes handle DST changes.
export function zonedToUtc({ y, m, d, hh, mm }, tz) {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    guess += target - asUtc;
  }
  return guess;
}

export const localToUtc = (s, tz) => zonedToUtc(parseLocal(s), tz);

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// "יום שישי 17.10 18:00"
export function formatHe(ms, tz, { withTime = true } = {}) {
  const p = localParts(new Date(ms), tz);
  const base = `יום ${HE_DAYS[p.weekday]} ${p.d}.${p.m}`;
  return withTime ? `${base} ${pad(p.hh)}:${pad(p.mm)}` : base;
}

export const heDayName = (weekday) => HE_DAYS[weekday];

/**
 * Next occurrence of a repeating reminder, strictly after afterMs.
 * rule: { freq: 'daily'|'weekly'|'monthly'|'yearly', interval?: n, days?: [0..6] (weekly, 0 = Sunday) }
 * start: the local "YYYY-MM-DDTHH:MM" of the first occurrence (keeps the wall-clock time and day of month).
 */
export function nextOccurrence(rule, start, afterMs, tz) {
  const s = parseLocal(start);
  const interval = Math.max(1, Math.floor(rule.interval ?? 1));
  const days = rule.freq === 'weekly' && rule.days?.length ? [...new Set(rule.days)].sort() : null;
  // Walk forward day by day (max ~3 years), check each candidate date.
  const startDay = Date.UTC(s.y, s.m - 1, s.d);
  for (let i = 0; i < 1200; i++) {
    const dt = new Date(startDay + i * 86_400_000);
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate(), wd = dt.getUTCDay();
    let ok = false;
    if (rule.freq === 'daily') ok = i % interval === 0;
    else if (rule.freq === 'weekly') {
      // Weeks start on Sunday; week 0 is the week of the start date.
      const startWd = new Date(startDay).getUTCDay();
      const week = Math.floor((i + startWd) / 7);
      ok = week % interval === 0 && (days ? days.includes(wd) : wd === startWd);
    } else if (rule.freq === 'monthly') {
      const months = (y - s.y) * 12 + (m - s.m);
      ok = d === s.d && months % interval === 0;
    } else if (rule.freq === 'yearly') ok = d === s.d && m === s.m && (y - s.y) % interval === 0;
    else throw new Error(`חזרה לא מוכרת: ${rule.freq}`);
    if (!ok) continue;
    const at = zonedToUtc({ y, m, d, hh: s.hh, mm: s.mm }, tz);
    if (at > afterMs) return at;
  }
  return null;
}

// Distance in meters (haversine).
export function distanceM(a, b) {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
