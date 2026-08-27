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
| `/wallet` | Your balance and the command list |
| `/wallet pay <player> <amount>` | Send money |
| `/wallet withdraw <amount> [denom]` | Take coins out of the wallet |
| `/wallet deposit [amount]` | Put coins back in |
| `/wallet history` | Your last transactions |
| `/wallet shop help` | How to build a chest shop |
| `/wallet plot` | Name, price and owner of the plot you stand in |
| `/wallet plot buy` | Buy that plot, it is claimed for you |
| `/wallet plot sell <price>` | List your own plot at your price |
| `/wallet plot unsell` | Take your plot off the market |
| `/wallet plot list` | Plots for sale |
| `/wallet admin balance <player>` | OP only - any player's balance, offline players included |
| `/wallet admin setbalance\|addbalance\|subtractbalance <player> <amount>` | OP only - move money |
| `/wallet admin history <player>` | OP only - a player's transactions |
| `/wallet admin shop list [player]` | OP only - all shops, tagged `[S]` server, `[I]` infinite, `[SI]` both |
| `/wallet admin shop convert-to-server` | OP only - toggle the shop you look at between server- and player-owned |
| `/wallet admin shop convert-to-infinite` | OP only - toggle infinite stock on the shop you look at |
| `/wallet admin shop server-balance [amount]` | OP only - show or set the server wallet |
| `/wallet admin plot add <price> [name]` | OP only - put the plot you stand in up for sale |
| `/wallet admin plot rename <name>` | OP only - rename that plot |
| `/wallet admin plot claim_as <player>` | OP only - give that plot to a player for free |
| `/wallet admin plot reclaim` | OP only - take it back from its owner, back on sale |
| `/wallet admin plot remove` | OP only - take it off the market |
| `/wallet admin plot list` | OP only - all plots and their owners |
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

## Wallet, shops and plots

`kubeshop.js` is the economy: a per-player balance in MySQL, physical coins, sign
shops on chests, and purchasable plots. It needs its own database — copy
`kubejs/config/kubeshop.example.json` to `kubejs/config/kubeshop.json` with the
credentials of a database created in the panel. Without it the script still loads
and every wallet command refuses with a "database is not loaded" message.

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

### Plots

One chunk each, named ("Plot 1", "Plot 2", …) so players never deal in chunk
coordinates. An OP stands in a chunk and runs `/wallet admin plot add <price>`;
a player stands in it and runs `/wallet plot buy`, and the chunk is claimed for
them through **Open Parties and Claims**. Owners resell at their own price with
`/wallet plot sell <price>`.

OPAC claims by UUID rather than by team, so `/wallet admin plot claim_as <player>`
works for a player who is offline. If the OPAC API is ever missing the plot is
still recorded and sold — only the automatic claim is skipped, with a line in
`logs/kubejs/server.log` saying so.

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
