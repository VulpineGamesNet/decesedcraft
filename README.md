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
