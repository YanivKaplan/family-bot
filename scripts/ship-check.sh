#!/bin/sh
# Claude Code Stop hook: a request is not finished until it is tested, committed, pushed and deployed.
# Exit 2 sends the message back to Claude, which then does the missing step. `npm run deploy` records the deployed commit.
cd "$(git rev-parse --show-toplevel)" || exit 0
# Asked once already in this stop: let it stop (no endless loop when a step cannot be done).
grep -q '"stop_hook_active": *true' 2>/dev/null && exit 0

todo=""
[ -n "$(git status --porcelain)" ] && todo="$todo uncommitted changes: run npm test, then commit (never .env or .dev.vars);"
git fetch -q origin 2>/dev/null
[ -n "$(git rev-list origin/main..HEAD 2>/dev/null)" ] && todo="$todo commits not pushed: git push;"
[ "$(cat .git/deployed-sha 2>/dev/null)" != "$(git rev-parse HEAD)" ] && todo="$todo HEAD is not deployed: npm run deploy;"
[ -z "$todo" ] && exit 0
echo "Before finishing:$todo (see CLAUDE.md)" >&2
exit 2
