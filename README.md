# DeceasedCraft Server Scripts

Custom KubeJS scripts for the Vulpine **DeceasedCraft — Urban Zombie Apocalypse**
server (Beta 5.10.x).

- Minecraft 1.20.1
- Forge 47.4.0
- KubeJS `2001.6.x`

The ATM10 equivalent lives in [atm10](https://github.com/VulpineGamesNet/atm10).
Note the two are **not** interchangeable: 1.20.1 uses NBT for item data where
1.21 uses data components, and KubeJS 6 differs from KubeJS 7 in places.

## Not in this repo

The Discord ↔ Minecraft chat bridge (the `discord_chat.js` script plus the bot
that talks to it) lives in [discordbot](https://github.com/VulpineGamesNet/discordbot),
so both halves of that bridge version together. Install it from there.

## Commands

| Command | Description |
|---|---|
| `/rules` | Display the server rules |
| `/discord`, `/dc` | Show the community Discord invite |
| `/vote` | Voting sites, streak and next reward |
| `/vote list` | Alias for `/vote` |
| `/vote stats` | Your voting stats |
| `/vote top` | Monthly leaderboard |
| `/vote claim` | Claim rewards earned while offline |
| `/kubevote …` | Console/RCON only — used by the votifier service |
| `/re`, `/r <message>` | Reply to your last conversation partner |
| `/msgtoggle` | Turn incoming private messages on or off |
| `/block <player> [reason]` | Stop a player messaging you |
| `/unblock <player>` | Unblock a player |
| `/blocklist` | List who you have blocked |
| `/playtime [player]` | Playtime, yours or another online player's |
| `/playtime --top [page]` | Online playtime leaderboard |
| `/srestart <minutes>` | Schedule a timed stop with countdown warnings (op) |
| `/srestart cancel` / `info` | Cancel or inspect a scheduled stop (op) |

### A note on `/srestart`

It issues vanilla `stop`. This server's startup command runs `java` directly
with no wrapper loop, so the process exits and stays down until it is started
again from the panel — the countdown and player warnings are the real value,
not an automatic comeback. ATM10 behaves the same in practice: its
`startserver.sh` does have a relaunch loop, but it is deliberately disabled so
the panel's Stop button works.

## Voting

`/vote` needs three things wired up:

1. **A database.** Create one in the Pterodactyl panel for this server and copy
   `kubejs/config/kubevote.example.json` to `kubejs/config/kubevote.json` with
   its credentials. Until then the script still loads but logs a connection
   failure and disables vote features — that is the intended degradation, not a
   crash.
2. **Voting sites.** `VOTING_SITES` in `vote_command.js` is empty until the
   DeceasedCraft listings exist. Each entry's `id` must match the service name
   the site sends, which is not always its domain — check the votifier log line
   `Received vote:` after a test vote.
3. **The votifier service**, listening on this server's own port with its own RSA
   keypair.

### Rewards

KubeShop coins, the same as ATM10. The base reward is $100, scaled by voting
streak, paid as $100 and $10 coins:

| Streak | Multiplier | Reward |
|---|---|---|
| — | 1.0 | $100 |
| 3 days | 1.5 | $150 |
| 7 days | 2.0 | $200 |
| 14 days | 2.5 | $250 |
| 30 days | 3.0 | $300 |

The coin NBT is byte-identical to what `kubeshop.js` produces, so a voted coin
and a withdrawn one are the same item and stack together. This is why `/vote`
depends on KubeShop being installed.

## Install

Merge into the server's existing `kubejs/` folder — **do not replace it**, the
modpack ships its own scripts there. The trailing `/.` is what makes `cp` merge:

```bash
cp -r kubejs/. /path/to/server/kubejs/
sudo chown -R 997:988 /path/to/server/kubejs
```

Then apply:

```
/kubejs reload server_scripts
```

Note the **underscore**. KubeJS 6 spells it `server_scripts`; KubeJS 7 on ATM10
spells it `server-scripts` with a hyphen. The wrong one just errors.

**Adding or changing a command needs a full server restart.** KubeJS builds the
Brigadier command tree at server start; `reload server-scripts` re-runs the
script bodies but leaves the registered commands bound to the previous load.

## Conventions

All scripts are wrapped in an IIFE. Every `server_scripts/*.js` in the pack
shares one global scope, so an unwrapped `let` that collides with a modpack
script is a hard load error and a colliding `function` silently overwrites.

Script `console` output goes to `logs/kubejs/server.log`, **not** `latest.log`
— that differs from KubeJS 7 on ATM10 and is an easy way to think a script
never ran.
