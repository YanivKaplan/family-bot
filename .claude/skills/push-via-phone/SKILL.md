---
name: push-via-phone
description: Push this repo to GitHub through the user's phone. agent-box has no GitHub credentials on purpose, so when the user asks to push (or CLAUDE.md's push step comes up), send the commits to their phone with Taildrop and they push from Termux. Use instead of `git push` on this machine.
---

# Push through the phone

agent-box (this machine) never holds GitHub credentials. The user's phone does, in Termux. The commits travel as a
git bundle over Tailscale (Taildrop), so nothing on this machine is opened to the network.

## Steps
1. `npm test` passes and everything is committed (`git status` is clean). Never bundle `.env`, `.dev.vars` or `data/`:
   they are not committed, so they are not in the bundle.
2. Make the bundle. The name carries the commit, so Android does not rename a second file to "(1)":
   ```
   sha=$(git rev-parse --short main)
   b=<scratchpad>/family-bot-$sha.bundle
   git bundle create "$b" main && git bundle verify "$b"
   ```
3. Send it: `sudo tailscale file cp "$b" s-s26-ultra:` (timeout about 3 minutes).
   If it says "s-s26-ultra is not replying", ask the user to open the Tailscale app on the phone, and send again.
4. Give the user these Termux commands, with the real file name:
   ```
   cd ~/family-bot && git pull ~/storage/downloads/family-bot-<sha>.bundle main && git push origin main
   ```
   If the file is not in Downloads, they find it with `ls ~/storage/downloads | grep bundle`.
5. When they say it is pushed, check from here: `git fetch -q origin && git rev-list --count origin/main..main` is 0.
   (The repo can be read without credentials.) Then the Stop hook's push check passes.

## First time on the phone (once)
```
pkg install git
termux-setup-storage            # lets Termux read Downloads
git clone https://github.com/YanivKaplan/family-bot ~/family-bot
```
GitHub login for `git push` lives on the phone only (for example a fine-grained token for this one repo).
