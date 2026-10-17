// Talk to the bot locally, without Telegram: npm run chat [-- path/to.db]
// Uses ANTHROPIC_API_KEY (and other settings) from .env. Data persists in ./data/local.db by default.
// Lines that start with ":" are harness commands; anything else is a private message to the bot.
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createHarness, USERS } from '../test/harness.mjs';
import { formatLists, formatReminders } from '../src/format.mjs';
import { formatHe } from '../src/time.mjs';

const dbPath = process.argv[2] ?? './data/local.db';
if (dbPath !== ':memory:') mkdirSync('./data', { recursive: true });
const h = await createHarness({ dbPath });
let as = 'יניב';
let chat = 'private';

const HELP = `:as <name>        speak as another family member (${Object.keys(USERS).join(', ')})
:group / :private  switch chat (group needs "בוט, ..." like the real group)
:state             lists, tasks, reminders, memory straight from the DB
:time <YYYY-MM-DDTHH:MM>   set the clock (local time)   :advance <minutes>
:tick              run the scheduler now (reminders, morning summary)
:quit`;

const show = ({ replies = [], calls = [], ms, usage }) => {
  for (const c of calls) console.log(`  · ${c.fn}(${c.args.map((a) => JSON.stringify(a)).join(', ').slice(0, 200)})`);
  for (const r of replies) console.log(`\n🤖 ${r}\n`);
  if (ms != null) console.log(`  [${ms} ms${usage ? `, in ${usage.input} / out ${usage.output} tokens, ${usage.searches ?? 0} searches` : ''}]`);
};

console.log(`local bot · db ${dbPath} · model ${h.config.model} · :help for commands`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question(`${formatHe(h.now(), h.config.tz)} ${as}@${chat}> `).catch(() => ':quit')).trim();
  if (!line) continue;
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');
  try {
    if (cmd === ':quit') break;
    else if (cmd === ':help') console.log(HELP);
    else if (cmd === ':as') as = arg;
    else if (cmd === ':group' || cmd === ':private') chat = cmd.slice(1);
    else if (cmd === ':time') h.setTime(arg);
    else if (cmd === ':advance') h.advance(Number(arg) * 60_000);
    else if (cmd === ':tick') show(await h.tick());
    else if (cmd === ':state') {
      const s = await h.state();
      console.log([formatLists(s.entries, h.config.tz, h.now()), formatReminders(s.reminders, h.config.tz)].join('\n\n'));
      for (const n of s.notes) console.log(`🧠 [${n.topic}] ${n.text}`);
    } else show(await h.say(line, { as, chat }));
  } catch (err) {
    console.log(`  ! ${err.message}`);
  }
}
rl.close();
h.close();
