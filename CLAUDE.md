# family-bot

## After every request
When a request changes code, finish it with all of these, in order (the Stop hook in `.claude/settings.json` checks it):
1. `npm test` passes. When the change affects what the bot says or saves, also `npm run test:live`.
2. Commit. Never commit `.env`, `.dev.vars` or `data/`; only `.env.example` holds config names.
3. `git push origin main`.
4. `npm run deploy` (wrangler deploy, and records the deployed commit in `.git/deployed-sha`).

## Data
All lists (shopping, tasks, baby prep, chores, gifts, anything) are one generic `entries` table with free JSON `fields`
and one set of tools (`list_add/show/update/delete/rename`). Do not add a table or tools per list type.
