# family-bot

## Layout
Two projects side by side, each with its own package.json and tests:
- `family-bot/` – the Telegram bot (Cloudflare Worker + D1). Its `/shopper/*` endpoints and `order_start` tool queue online orders;
  `meals_menu` and the weekly suggestion (src/yummi.mjs) read the family's יאמי account through the shopper.
- `shopper/` – runs on the home machine (agent-box): takes confirmed orders from the Worker and fills the Carrefour or יאמי cart in
  Chromium. Its instructions are the skills `.claude/skills/carrefour-order` and `.claude/skills/yummi-order`.
`npm test`, `npm run test:live` and `npm run deploy` at the repo root run them for both / for the bot.

## After every request
When a request changes code, finish it with all of these, in order (the Stop hook in `.claude/settings.json` checks it):
1. `npm test` passes. When the change affects what the bot says or saves, also `npm run test:live`.
2. Commit. Never commit `.env`, `.dev.vars` or `data/`; only `.env.example` holds config names.
3. Push. Not with `git push` from agent-box: it has no GitHub credentials on purpose. Use the skill
   `.claude/skills/push-via-phone` (the phone pulls the commits over SSH on Tailscale and pushes from Termux).
4. `npm run deploy` (wrangler deploy, and records the deployed commit in `.git/deployed-sha`).

## Data
All lists (shopping, tasks, baby prep, chores, gifts, anything) are one generic `entries` table with free JSON `fields`
and one set of tools (`list_add/show/update/delete/rename`). Do not add a table or tools per list type.
