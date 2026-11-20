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

The economy runs in the server-side Wallet and WalletAuction Forge mods. The old
`kubeshop.js` and transitional `plots_command.js` are archived under `legacy/`;
they must stay outside the active `kubejs/server_scripts/` directory.

## Commands

| Command | Description |
|---|---|
| `/wallet` | Your balance and the command list |
| `/wallet pay <player> <amount>` | Send money |
| `/wallet withdraw <amount> [denom]` | Take coins out of the wallet |
| `/wallet deposit [amount]` | Put coins back in |
| `/wallet history` | Your last transactions |
| `/wallet shop help` | How to build a chest shop |
| `/wallet ah` | Open the player auction house |
| `/wallet ah sell <price> [amount]` | List the held item immediately |
| `/wallet admin balance <player>` | OP only - any player's balance, offline players included |
| `/wallet admin setbalance\|addbalance\|subtractbalance <player> <amount>` | OP only - move money |
| `/wallet admin history <player>` | OP only - a player's transactions |
| `/wallet admin shop list [player]` | OP only - all shops, tagged `[S]` server, `[I]` infinite, `[SI]` both |
| `/wallet admin shop convert-to-server` | OP only - toggle the shop you look at between server- and player-owned |
| `/wallet admin shop convert-to-infinite` | OP only - toggle infinite stock on the shop you look at |
| `/wallet admin shop server-balance [amount]` | OP only - show or set the server wallet |
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

Restarts are scheduled from Discord (`/restart` in the server's channel, run by
the [discordbot](https://github.com/VulpineGamesNet/discordbot)), which counts
down in game, restarts through the Pterodactyl panel and watches the server come
back. The old in-game `/srestart` was removed on 2026-09-15.

## Wallet, shops and auctions

Wallet provides per-player MySQL balances, physical coins, and sign shops on
chests. WalletAuction provides player listings through `/wallet ah`. The live DC economy
uses panel-managed `s6_wallet`, copied from the former `s6_kubeshop` database
on 2026-10-12. The mod reads `config/wallet.json`; set `backend` to `mysql`,
`database` to `s6_wallet`, and `strictItemMatch` to `false` for DC's item-ID
shop matching. Keep the panel credentials only in that server-side config.
The original `s6_kubeshop` database remains untouched for rollback.

Coins are gold nuggets carrying `CustomModelData` 719001 / 719010 / 719100 /
719999 / 710000 for $1 / $10 / $100 / $1,000 / $10,000. Right-click deposits one,
crouch right-click deposits the stack.

### Shops

Put a chest down, stock it with exactly what one trade should move, put a wall
sign on it reading `[BUY]` or `[SELL]` on the first line and the price on the
last, then crouch right-click the sign. `[BUY]` sells the chest's contents to
players; `[SELL]` buys them from players and pays out of the shop owner's wallet.
The sign is waxed on creation, and only its owner (or an OP) can break the sign
or the chest.

An OP can retag any shop while looking at its sign:

- `/wallet admin shop convert-to-server` — the money moves to and from the server
  wallet instead of the creator's. The row keeps its creator, so the list still
  shows who built it, but from then on only an OP can break it.
- `/wallet admin shop convert-to-infinite` — the chest stops being the stock. A
  `[BUY]` shop hands out copies and never drains; a `[SELL]` shop destroys what it
  buys and never fills up.

Both commands toggle, so running one twice undoes it. A server `[SELL]` shop pays
out of the server wallet, which no player name resolves to — fill it with
`/wallet admin shop server-balance <amount>`.

### Auctions

Hold an item and run `/wallet ah sell <price> [amount]` to list it. `/wallet ah`
opens a chest menu for browsing, inspecting, buying, and cancelling listings.
Each purchase buys the whole listed stack. Purchased items and unsold returns
are delivered automatically when the player has inventory space.

`announcer.js` runs every two hours while players are online. Its economy
message links `/wallet` and `/wallet ah` every four hours.

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

Wallet coins, the same physical coin IDs as before. The base reward is $100, scaled by voting
streak, paid as $100 and $10 coins:

| Streak | Multiplier | Reward |
|---|---|---|
| — | 1.0 | $100 |
| 3 days | 1.5 | $150 |
| 7 days | 2.0 | $200 |
| 14 days | 2.5 | $250 |
| 30 days | 3.0 | $300 |

The vote script still creates gold nuggets with CustomModelData `719100` and
`719010`, which Wallet accepts as $100 and $10 coins.

## Install

Install the server-side Wallet and WalletAuction Forge 1.20.1 jars and configure
`config/wallet.json` for `s6_wallet` before starting the server. Merge this
repo's `kubejs/` into the server's existing folder; the modpack ships its own
scripts there. The trailing `/.` makes `cp` merge:

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
Brigadier command tree at server start; `reload server_scripts` re-runs the
script bodies but leaves the registered commands bound to the previous load.

## Conventions

All scripts are wrapped in an IIFE. Every `server_scripts/*.js` in the pack
shares one global scope, so an unwrapped `let` that collides with a modpack
script is a hard load error and a colliding `function` silently overwrites.

Script `console` output goes to `logs/kubejs/server.log`, **not** `latest.log`
— that differs from KubeJS 7 on ATM10 and is an easy way to think a script
never ran.
