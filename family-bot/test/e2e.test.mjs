// End-to-end: real FamilyBot, Telegram and Claude clients against fake HTTP servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HouseDB } from '../src/db.mjs';
import { NodeSqliteAdapter } from '../src/node-sqlite.mjs';
import { Telegram } from '../src/telegram.mjs';
import { Claude } from '../src/claude.mjs';
import { FamilyBot } from '../src/bot.mjs';
import { loadConfig } from '../src/config.mjs';
import { localToUtc } from '../src/time.mjs';

const GROUP = -1001;
const DAD = 11, MOM = 12, STRANGER = 99;
const TZ = 'Asia/Jerusalem';

function server(handler) {
  const s = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const out = await handler(req.url, JSON.parse(body || '{}'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, url: `http://127.0.0.1:${s.address().port}` })));
}

// Telegram: records every call.
const tgCalls = [];
// Claude: a script function decides the reply for each request.
const claudeReqs = [];
let script = () => ({ content: [{ type: 'text', text: 'בסדר' }], stop_reason: 'end_turn' });

let tgSrv, claudeSrv, bot, db;

before(async () => {
  tgSrv = await server((url, body) => {
    const method = url.split('/').at(-1);
    tgCalls.push({ method, body });
    if (method === 'getMe') return { ok: true, result: { id: 500, username: 'home_helper_bot', is_bot: true } };
    return { ok: true, result: { message_id: 900 + tgCalls.length } };
  });
  claudeSrv = await server((url, body) => {
    claudeReqs.push(body);
    return { id: 'm', type: 'message', role: 'assistant', usage: { input_tokens: 100, output_tokens: 20 }, ...script(body) };
  });
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: '500:secret', ANTHROPIC_API_KEY: 'k', ALLOWED_CHAT_IDS: String(GROUP), ALLOWED_USER_IDS: `${DAD},${MOM}`,
    DIGEST_TIME: '07:30', MAX_DAILY_CALLS: '50', FAMILY_MEMBERS: 'יניב,מיכל',
  });
  db = new HouseDB(await NodeSqliteAdapter.open(':memory:'));
  await db.init();
  const telegram = new Telegram({ token: 't', baseUrl: tgSrv.url });
  const claude = new Claude({ apiKey: 'k', model: 'test-model', baseUrl: claudeSrv.url });
  bot = new FamilyBot({ config, db, telegram, claude, log: {} });
  await bot.identity();
});

after(() => { tgSrv.s.close(); claudeSrv.s.close(); });

let mid = 1;
const groupMsg = (text, from = DAD, extra = {}) => ({
  update_id: mid, message: { message_id: mid++, date: 0, chat: { id: GROUP, type: 'supergroup', title: 'משפחה' }, from: { id: from, first_name: from === DAD ? 'יניב' : 'מיכל' }, text, ...extra },
});
const sends = () => tgCalls.filter((c) => c.method === 'sendMessage');
const reset = () => { tgCalls.length = 0; claudeReqs.length = 0; };

test('ignores group chatter that is not for the bot', async () => {
  reset();
  await bot.handle(groupMsg('מישהו ראה את המפתחות?'));
  assert.equal(claudeReqs.length, 0);
  assert.equal(sends().length, 0);
});

test('wake word -> Claude -> tool -> reply in the group', async () => {
  reset();
  script = (body) => {
    const last = body.messages.at(-1);
    if (typeof last.content === 'string') {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'list_add', input: { entries: [{ list: 'סופר', text: 'חלב', fields: { qty: 2 } }, { list: 'סופר', text: 'ביצים' }] } }] };
    }
    assert.equal(last.content[0].type, 'tool_result');
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'הוספתי לסופר: חלב ×2, ביצים' }] };
  };
  await bot.handle(groupMsg('בוט, תוסיף 2 חלב וביצים'));
  assert.equal(claudeReqs.length, 2);
  const first = claudeReqs[0];
  assert.equal(first.messages.at(-1).content, 'יניב: תוסיף 2 חלב וביצים', 'wake word removed, sender added');
  assert.match(first.system[1].text, /הזמן עכשיו/);
  assert.match(first.system[1].text, /יניב: מישהו ראה את המפתחות\?/, 'earlier group chatter is context');
  assert.deepEqual(first.system[0].cache_control, { type: 'ephemeral', ttl: '1h' }, 'system prompt cached for an hour');
  assert.deepEqual(first.tools.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' }, 'tools cached for an hour');
  assert.deepEqual(first.cache_control, { type: 'ephemeral' }, 'the tool loop caches the conversation tail');
  assert.equal(first.system[1].cache_control, undefined, 'the changing context (time, recent chat) is not cached');
  assert.equal((await db.entries()).length, 2);
  const s = sends().at(-1);
  assert.equal(s.body.chat_id, GROUP);
  assert.equal(s.body.text, 'הוספתי לסופר: חלב ×2, ביצים');
  assert.ok(s.body.reply_parameters, 'answers as a reply');
  assert.equal(s.body.parse_mode, undefined, 'plain text only');
});

test('history gives context to the next message', async () => {
  reset();
  script = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'אוקיי' }] });
  await bot.handle(groupMsg('@home_helper_bot גם לחם', MOM));
  const msgs = claudeReqs[0].messages;
  assert.equal(msgs[0].content, 'יניב: תוסיף 2 חלב וביצים');
  assert.equal(msgs.at(-1).content, 'מיכל: גם לחם');
});

test('reply to the bot triggers it; /list needs no model', async () => {
  reset();
  await bot.handle(groupMsg('קניתי את החלב', MOM, { reply_to_message: { message_id: 1, from: { id: 500 } } }));
  assert.equal(claudeReqs.length, 1);
  reset();
  await bot.handle(groupMsg('/list@home_helper_bot'));
  assert.equal(claudeReqs.length, 0);
  assert.match(sends().at(-1).body.text, /📋 סופר:\n• חלב × 2\n• ביצים/);
  reset();
  await bot.handle(groupMsg('/list@other_bot'));
  assert.equal(sends().length, 0, 'commands for another bot are ignored');
});

test('strangers and other groups are blocked', async () => {
  reset();
  await bot.handle({ update_id: 1, message: { message_id: 1, chat: { id: STRANGER, type: 'private' }, from: { id: STRANGER, first_name: 'X' }, text: 'תוסיף ויסקי' } });
  assert.equal(claudeReqs.length, 0);
  assert.match(sends().at(-1).body.text, /פרטי/);
  reset();
  await bot.handle({ update_id: 2, my_chat_member: { chat: { id: -777, type: 'group' }, new_chat_member: { status: 'member' } } });
  assert.ok(tgCalls.some((c) => c.method === 'leaveChat' && c.body.chat_id === -777));
  reset();
  await bot.handle({ update_id: 3, message: { message_id: 3, chat: { id: -777, type: 'group' }, from: { id: DAD, first_name: 'יניב' }, text: 'בוט, מה ברשימה?' } });
  assert.equal(claudeReqs.length, 0);
});

test('private chat with a family member works without a wake word', async () => {
  reset();
  script = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'היי' }] });
  await bot.handle({ update_id: 4, message: { message_id: 4, chat: { id: MOM, type: 'private' }, from: { id: MOM, first_name: 'מיכל' }, text: 'מה יש לי היום?' } });
  assert.equal(claudeReqs.length, 1);
});

test('live location near a saved place: one short message, once per day', async () => {
  await db.savePlace({ name: 'קניון הזהב', kind: 'קניון', lat: 31.9897, lon: 34.7743 });
  await db.addEntries([{ list: 'משימות', text: 'להחליף נעליים', fields: { places: ['קניון'] } }], 'יניב');
  reset();
  script = (body) => {
    assert.match(body.messages.at(-1).content, /^\[מערכת\] מיכל נמצא\/ת עכשיו ליד "קניון הזהב"/);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'מיכל, את בקניון: אפשר להחליף את הנעליים 👟' }] };
  };
  const live = (id) => ({ update_id: id, edited_message: { message_id: 50, chat: { id: GROUP, type: 'supergroup' }, from: { id: MOM, first_name: 'מיכל' }, location: { latitude: 31.9899, longitude: 34.7745, live_period: 3600 } } });
  await bot.handle(live(10));
  await bot.handle(live(11));
  assert.equal(claudeReqs.length, 1, 'second live update on the same day is silent');
  assert.match(sends().at(-1).body.text, /נעליים/);
  // Far away: nothing.
  reset();
  await bot.handle({ update_id: 12, edited_message: { message_id: 50, chat: { id: GROUP, type: 'supergroup' }, from: { id: DAD, first_name: 'יניב' }, location: { latitude: 32.5, longitude: 35, live_period: 3600 } } });
  assert.equal(claudeReqs.length + sends().length, 0);
});

test('"-" from the model means stay silent for live location', async () => {
  await db.savePlace({ name: 'דואר', kind: 'דואר', lat: 32.0, lon: 34.8 });
  reset();
  script = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '-' }] });
  await bot.handle({ update_id: 13, edited_message: { message_id: 51, chat: { id: GROUP, type: 'supergroup' }, from: { id: DAD, first_name: 'יניב' }, location: { latitude: 32.0001, longitude: 34.8001, live_period: 600 } } });
  assert.equal(claudeReqs.length, 1);
  assert.equal(sends().length, 0);
});

test('scheduler sends due reminders once and moves repeating ones', async () => {
  const now = localToUtc('2026-10-18T19:00', TZ);
  await db.addReminder({ chat_id: GROUP, text: 'להוציא פח', start_local: '2026-10-18T19:00', next_at: now, rule: null }, 'יניב');
  await db.addReminder({ chat_id: GROUP, text: 'מחזור', start_local: '2026-10-18T19:00', next_at: now, rule: { freq: 'weekly' } }, 'יניב');
  reset();
  await bot.tick(now + 1000);
  await bot.tick(now + 31_000);
  const texts = sends().map((s) => s.body.text);
  assert.deepEqual(texts.filter((t) => t.startsWith('⏰')).sort(), ['⏰ תזכורת: להוציא פח', '⏰ תזכורת: מחזור'].sort());
  const weekly = (await db.activeReminders()).find((r) => r.text === 'מחזור');
  assert.equal(weekly.next_at, localToUtc('2026-10-25T19:00', TZ));
  assert.equal((await db.activeReminders()).some((r) => r.text === 'להוציא פח'), false);
});

test('reminder buttons: done closes the task, snooze makes a one-time copy, no Claude call', async () => {
  const now = localToUtc('2026-10-20T18:00', TZ);
  const [task] = await db.addEntries([{ list: 'משימות', text: 'לקבוע תור לרופא' }], 'יניב');
  const r = await db.addReminder({ chat_id: GROUP, text: 'לקבוע תור', start_local: '2026-10-20T18:00', next_at: now, rule: { freq: 'daily' }, task_id: task.id }, 'יניב');
  reset();
  await bot.tick(now + 1000);
  const sent = sends().find((s) => s.body.text.startsWith('⏰'));
  assert.deepEqual(sent.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`r:${r.id}:done`, `r:${r.id}:h1`, `r:${r.id}:d1`]);

  let uid = 7000;
  const click = (data, from = DAD) => bot.handle({ update_id: ++uid, callback_query: {
    id: `q${uid}`, data, from: { id: from, first_name: from === DAD ? 'יניב' : 'זר' },
    message: { message_id: 55, chat: { id: GROUP, type: 'group' }, text: sent.body.text },
  } });
  const calls = (m) => tgCalls.filter((c) => c.method === m);
  const realNow = Date.now;
  Date.now = () => now + 60_000;
  try {
    reset();
    await click(`r:${r.id}:h1`);
    await click(`r:${r.id}:d1`);
    const copies = (await db.activeReminders()).filter((x) => x.text === 'לקבוע תור' && x.id !== r.id).map((x) => x.next_at).sort();
    assert.deepEqual(copies, [now + 60_000 + 3600_000, localToUtc('2026-10-21T18:01', TZ)]);
    assert.equal(calls('editMessageText').length, 2);
    assert.match(calls('editMessageText')[0].body.text, /⏰ נדחה ל.* ע"י יניב$/);
    assert.equal(calls('editMessageText')[0].body.reply_markup, undefined);

    reset();
    await click(`r:${r.id}:done`, STRANGER);
    assert.equal((await db.entry(task.id)).done_at, null);
    assert.equal(calls('editMessageText').length, 0);
    assert.equal(calls('answerCallbackQuery').length, 1);

    await click(`r:${r.id}:done`);
    assert.ok((await db.entry(task.id)).done_at);
    assert.equal((await db.activeReminders()).some((x) => x.task_id === task.id), false);
    assert.match(calls('editMessageText')[0].body.text, /✅ בוצע ע"י יניב$/);
    assert.equal(calls('answerCallbackQuery').length, 2);
    assert.equal(claudeReqs.length, 0);
  } finally {
    Date.now = realNow;
  }
});

test('morning digest once per day', async () => {
  await db.addEntries([{ list: 'משימות', text: 'לשלם ארנונה', fields: { due: '2026-10-19T12:00' } }], 'יניב');
  reset();
  const morning = localToUtc('2026-10-19T07:31', TZ);
  await bot.tick(morning);
  await bot.tick(morning + 60_000);
  const digests = sends().filter((s) => s.body.text.startsWith('☀️'));
  assert.equal(digests.length, 1);
  assert.match(digests[0].body.text, /לשלם ארנונה/);
});

test('memory topics reach the model; web search pauses continue and sources are shown', async () => {
  await db.saveNote({ topic: 'כסף', text: 'תקציב אוכל: 3,000 ₪' }, 'יניב');
  reset();
  let n = 0;
  script = () => {
    n++;
    if (n === 1) return { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'דואר שעות' } }] };
    return {
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
      content: [
        { type: 'text', text: 'הסניף פתוח ' },
        { type: 'text', text: 'עד 13:00 היום.', citations: [{ type: 'web_search_result_location', url: 'https://example.co.il/post', cited_text: '...' }] },
      ],
    };
  };
  await bot.handle(groupMsg('בוט, עד מתי הדואר פתוח היום?'));
  assert.equal(claudeReqs.length, 2, 'pause_turn is continued');
  assert.match(claudeReqs[0].system[1].text, /נושאים בזיכרון הקבוע: כסף \(1\)/);
  assert.equal(claudeReqs[1].messages.at(-1).role, 'assistant', 'the paused turn is sent back as is');
  assert.equal(sends().at(-1).body.text, 'הסניף פתוח עד 13:00 היום.\n\nמקורות:\nhttps://example.co.il/post');
});

test('daily limit stops model calls', async () => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  await db.set(`usage:${day}`, { calls: 50 });
  reset();
  await bot.handle(groupMsg('בוט, מה נשמע?'));
  assert.equal(claudeReqs.length, 0);
  assert.match(sends().at(-1).body.text, /מגבלת/);
});
