---
name: push-via-phone
description: Push this repo to GitHub through the user's phone. agent-box has no GitHub credentials on purpose, so when the user asks to push (or CLAUDE.md's push step comes up), the phone pulls the commits from agent-box over SSH (Tailscale) and pushes them from Termux. Use instead of `git push` on this machine.
---

# Push through the phone

agent-box (this machine) never holds GitHub credentials. The user's phone (Termux) does. The phone pulls the
commits from here over SSH on Tailscale, then pushes them. Only committed code moves: never copy the folder itself,
it holds `shopper/.env` (the shopper secret) and `.wrangler/`.

## Steps
1. `npm test` passes and everything is committed (`git status` is clean).
2. Tell the user how many commits are waiting (`git rev-list --count origin/main..main` after `git fetch -q origin`),
   and give them this Termux command:
   ```
   cd ~/family-bot && git pull --ff-only ssh://opc@100.71.148.71/home/opc/agents/family-bot main && git push origin main
   ```
3. When they say it is pushed, check from here: `git fetch -q origin && git rev-list --count origin/main..main` is 0.
   (The repo can be read without credentials.) Then the Stop hook's push check passes.

If the pull fails with "Permission denied (publickey)", the phone's key is not in `~/.ssh/authorized_keys` here
(see the setup below). If it cannot connect, Tailscale is off on the phone.

## First time on the phone (once)
In Termux:
```
pkg install git openssh
ssh-keygen -t ed25519 -C termux-phone      # Enter for the defaults
cat ~/.ssh/id_ed25519.pub
git clone https://github.com/YanivKaplan/family-bot ~/family-bot
```
The user adds that public key to `~/.ssh/authorized_keys` on agent-box themselves (for example
`! echo '<key>' >> ~/.ssh/authorized_keys` in Claude Code). Claude does not add keys.
GitHub login for `git push` lives on the phone only (for example a fine-grained token for this one repo).
