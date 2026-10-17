# עוזר הבית – family home assistant for Telegram

A private Telegram assistant for one family. It lives in your family group, speaks Hebrew, and uses Claude (Anthropic API) when it must understand or think.

What it does:

- **Any list** – shopping (סופר, פארם...), tasks, baby equipment, chores, gifts, or any new list you name. Each item can have any details: quantity, a person, a due date, the **places** where you can do it (קניון, דואר, אונליין...), a price, a size. Add, show, edit, move, close, reopen and delete, all in free Hebrew: "בוט, תוסיף חלב", "בוט, קניתי את החלב", "בוט, תעביר את החיתולים לפארם", "בוט, תמחק את העגלה". `/list` shows all lists.
- **Reminders** – one-time or repeating, sent to the group: "בוט, תזכיר כל יום ראשון ב-7 לשים זבל למחזור".
- **"We are at the mall"** – "בוט, אנחנו בקניון" gives the tasks and items for that place. With **live location** in the group, the bot sends one message when a family member arrives at a saved place (only if there is something to do there).
- **Household memory** – "בוט, תזכור שתקציב האוכל שלנו הוא 3,000 ₪". The bot uses these facts in later discussions.
- **Discussions and advice** – planning a week, meals, an event, or how to manage the expenses better. Web search for current facts (opening hours, prices, holidays), with sources.
- **Morning summary** – at 07:30, the tasks and reminders for today (only if there are some).

## Architecture

```
Family Telegram group ──webhook (secret header)──> Cloudflare Worker ──> Claude API (tools + web search)
                                                          │
                              cron, every minute ─────────┤
                                                          └── Cloudflare D1 (SQLite): lists (one generic table),
                                                              reminders, places, memory
```

- **Hosting: Cloudflare Workers, free plan.** No credit card. Telegram calls the bot, so nothing runs all the time. The cron trigger sends the reminders.
- **No npm dependencies.** Only platform built-ins (`fetch`, D1). No supply-chain risk from packages.
- `/list`, `/reminders`, `/help` and the reminders do not call Claude, so they cost nothing.
- The same code also runs on Node 22 with long polling (`npm start`, or the `Dockerfile`), if you want to host it yourself later.

## Security

Only your family can use the bot:

| Control | What it stops |
| --- | --- |
| Telegram sends a secret token (`WEBHOOK_SECRET`) in a header with each update. The Worker checks it (constant-time) and rejects all other calls with 403. Other paths return 404. | Fake updates from the internet |
| Each sender must be in `ALLOWED_USER_IDS`, also inside the group. The group must be in `ALLOWED_CHAT_IDS`. | Strangers, and a person who is added to the group by mistake |
| The bot leaves any other group. After setup, `/setjoingroups` → Disable in @BotFather. | Use of the bot in other groups |
| The token, the API key, the secret and the ids are Cloudflare **encrypted secrets**, not in the code. | Secrets in GitHub |
| Each update is handled once (`seen_updates` table). | Double actions when Telegram retries |
| Claude can only change household data. It cannot pay, send email or open apps. The one outside action is filling the Carrefour cart for a list the family confirmed (`order_start`): the shopper on the home machine (`../shopper`) stops before payment and never types card details. The prompt forbids saving card numbers, bank accounts, passwords and ID numbers in memory. | Damage from a wrong or manipulated answer |
| `MAX_DAILY_CALLS` (300), max 8 model steps per message, max 3 web searches per message, and a spend limit on the Anthropic workspace. | Unexpected cost |
| Replies are plain text (no Markdown/HTML). | Links or formatting injected through text |

Privacy notes:
- In the group, the bot receives all messages (this is necessary for the wake word "בוט" and for live location). It does not answer messages that are not for it. The last `GROUP_CONTEXT` (15) of them from the last 2 hours are kept, so the bot understands "בוט, תוסיף את זה". They go to Claude only together with a message for the bot. `GROUP_CONTEXT=0` turns this off: then the bot drops these messages.
- The last 24 lines of each bot conversation are kept for 12 hours, for context.
- The last shared location of a chat is kept for 30 minutes. Coordinates are saved only when you ask to save a place.
- Messages for the bot go to the Anthropic API. By default, Anthropic does not use API data to train models.

Make the Telegram group itself private: no public link, and "Approve new members" on.

## Setup (about 30 minutes, possible from a phone)

### 1. Make the Telegram bot
1. In Telegram, open **@BotFather** and send `/newbot`. Give a name ("עוזר הבית") and a username (for example `kaplan_home_bot`). Keep the **token**.
2. Send `/setprivacy` → select the bot → **Disable**. (Then the bot can see "בוט, ..." and live locations in the group.)

### 2. Get a Claude API key
1. Open https://platform.claude.com. Make a workspace for the bot (for example "family-bot") and an API key in it.
2. In the workspace limits, set a monthly spend limit (for example $10).

Note: a Claude app subscription (Pro/Max) cannot be used by a bot. The API is pay-per-use.

### 3. Make a webhook secret
Make a random string of 48 characters with only letters, digits, `_` and `-`, for example with your password manager. This is `WEBHOOK_SECRET`.

### 4. Deploy to Cloudflare
**Option A – the button (no computer needed):**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YanivKaplan/family-bot/tree/main/family-bot)

1. Open the button link and log in to Cloudflare (a free account, no card).
2. Cloudflare copies the repository to your GitHub, creates the D1 database, and asks for the secrets. Enter `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY` and `WEBHOOK_SECRET`. Leave `ALLOWED_CHAT_IDS`, `ALLOWED_USER_IDS` and `FAMILY_MEMBERS` empty for now.
3. When the deploy is complete, copy the Worker address, for example `https://family-home-bot.<your-name>.workers.dev`.

**Option B – from a computer:**
```bash
cd family-bot
npx wrangler login
npx wrangler deploy                       # creates the D1 database and the Worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WEBHOOK_SECRET
```

### 5. Connect Telegram to the Worker
Open this address in a browser (put in your token, Worker address and secret):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://family-home-bot.<your-name>.workers.dev/telegram&secret_token=<WEBHOOK_SECRET>&allowed_updates=["message","edited_message","my_chat_member"]&drop_pending_updates=true
```

The answer must be `{"ok":true,"result":true,"description":"Webhook was set"}`.

### 6. Connect the family group
1. Add the bot to the family group. The bot writes "מצב הגדרה" with the group id (a negative number).
2. Each family member opens a private chat with the bot and sends `/id`. Write down each `user id`.
3. In the Cloudflare dashboard → Workers → family-home-bot → Settings → Variables and Secrets, add these secrets:
   - `ALLOWED_CHAT_IDS` = the group id
   - `ALLOWED_USER_IDS` = the user ids, comma-separated
   - `FAMILY_MEMBERS` = your names, comma-separated (for example `יניב,מיכל,נועה`)
4. In @BotFather, send `/setjoingroups` → select the bot → **Disable**.
5. In the group, write: `בוט, עזרה`.

### 7. Save your places
1. At the mall, share your location in the group (📎 → Location → Send my current location).
2. Reply to the bot: `תשמור את זה כקניון הזהב, סוג קניון`.
3. Do the same for the supermarket, the post office and the pharmacy.

## Use

In the group, start with **בוט** (or **עוזר**), tag the bot, or reply to a bot message. In a private chat with the bot, write normally.

```
בוט, תוסיף לסופר חלב, 2 לחם ושמן זית
בוט, משימה: להחליף את הנעליים של נועה, בקניון, עד יום חמישי
בוט, אנחנו בקניון, מה אפשר לעשות פה?
בוט, תזכיר לנו מחר ב-20:00 להוציא את הפח
בוט, תזכור שתקציב האוכל שלנו הוא 3,000 ₪ בחודש
בוט, בוא נחשוב איך לחסוך 1,000 ₪ בחודש
בוט, עד מתי הדואר בגבעתיים פתוח היום?
/list   /reminders   /help
```

## Settings

Plain settings are in `wrangler.toml` under `[vars]` (or the dashboard). Secrets are listed in `.dev.vars.example`.

| Setting | Meaning | Default |
| --- | --- | --- |
| `WAKE_WORDS` | Words that call the bot in the group | `בוט,עוזר,bot` |
| `DIGEST_TIME` | Time of the morning summary; empty = off | `07:30` |
| `CLAUDE_MODEL` | `claude-haiku-5-5` is cheaper; `claude-opus-5-5` is stronger | `claude-sonnet-5-5` |
| `MAX_DAILY_CALLS` | Model calls per day | `300` |
| `GROUP_CONTEXT` | Recent group messages (not for the bot, last 2 hours) given as context; 0 = off | `15` |
| `WEB_SEARCH` | Web search for current facts ($10 per 1,000 searches) | `true` |

## Limits of the free plan

- Cloudflare Workers free: 100,000 requests per day (a family uses a few hundred), and **10 ms CPU** per request. Waits for Telegram and Claude do not count as CPU. A very large web search result can pass the CPU limit; if you see "Exceeded CPU" in the Worker logs, set `WEB_SEARCH=false` or move to Workers Paid ($5/month).
- D1 free: 5 GB, much more than this bot needs.

## Development

```bash
npm test     # unit tests, end-to-end tests, and Worker tests with fake Telegram, Claude and D1
npm start    # local run with long polling (needs .env, Node 22.13+)
npm run chat       # talk to the bot locally, no Telegram (real Claude, needs ANTHROPIC_API_KEY in .env). :help for commands
npm run test:live  # a scripted family week against the real Claude: checks saved data, answers and time per answer
npm run deploy     # wrangler deploy, and records the deployed commit
```

Working with Claude Code: `CLAUDE.md` says every change ends with test, commit, push and deploy, and a Stop hook (`.claude/settings.json` → `scripts/ship-check.sh`) does not let a request finish while something is uncommitted, unpushed or not deployed.

`test/harness.mjs` runs the real bot with a fake Telegram and a controllable clock. Use it to try a prompt change: run `npm run test:live` (add `LIVE_VERBOSE=1` to see each request, DB call and answer), change `src/prompt.mjs`, run again.

| File | Contents |
| --- | --- |
| `src/worker.mjs` | Cloudflare entry: webhook (secret check, once-only), cron |
| `src/index.mjs` | Node entry: long polling + 30-second scheduler |
| `src/bot.mjs` | Access control, wake word, locations, reminders, morning summary |
| `src/claude.mjs` | Claude Messages API: tool loop, web search, prompt caching |
| `src/tools.mjs` | The tools that Claude can call: generic lists (`list_*`), reminders, places, memory |
| `src/prompt.mjs` | The Hebrew system prompt |
| `src/db.mjs` | Tables and data functions (async) |
| `src/d1.mjs`, `src/node-sqlite.mjs` | SQL back ends: Cloudflare D1, node:sqlite |
| `src/time.mjs` | Time zone, repeating dates, distance |
| `src/format.mjs` | Fixed Hebrew texts |

## Next steps (not in version 1)

- Expenses: import credit-card exports and discuss the real numbers with the bot.
- Mirror the lists to one Google Sheet, with a service account that has access only to that sheet.
- Voice messages (Hebrew speech to text) and receipt photos.
