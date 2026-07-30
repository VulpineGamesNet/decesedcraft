// DeceasedCraft port (MC 1.20.1, Forge, KubeJS 2001.6.5). Same behaviour as the ATM10 copy.
// Private message extras, SimplePMs-style, on top of vanilla /msg:
//   /re, /r <message>   reply to last conversation partner
//   /msgtoggle          turn incoming private messages on/off
//   /block <player> [reason] | /unblock <player> | /blocklist
// Vanilla /msg|/tell|/w is not replaced, only observed and vetoed, so chat
// signing, mute and NoChatReports behaviour stay untouched.
// Toggle + blocks live in player persistent NBT, so they survive restarts.
// Last conversation partner is stored the same way, so /re survives a relog.

// Wrapped in an IIFE: KubeJS server scripts all share one global scope.
(function () {

const WHISPER = /^\/?(?:msg|tell|w)\s+(\S+)\s+\S/i
const TOGGLE_KEY = "pmDisabled"
const BLOCK_KEY = "pmBlocked"
const LAST_KEY = "pmLastPartner"

// Java strings come back wrapped, and a wrapper is always truthy - String()
// makes them behave like the JS strings the rest of this script expects.
function str(value) {
  return String(value)
}

function playerName(player) {
  return str(player.getName().getString())
}

function getLastPartner(player) {
  return str(player.persistentData.getString(LAST_KEY))
}

function setLastPartner(player, partner) {
  player.persistentData.putString(LAST_KEY, str(partner))
}

function getBlocks(player) {
  const raw = str(player.persistentData.getString(BLOCK_KEY))
  return raw ? JSON.parse(raw) : {}
}

function setBlocks(player, blocks) {
  player.persistentData.putString(BLOCK_KEY, JSON.stringify(blocks))
}

function pmsDisabled(player) {
  return player.persistentData.getBoolean(TOGGLE_KEY)
}

ServerEvents.command(event => {
  const parse = event.parseResults
  const sender = parse.getContext().getSource().getPlayer()
  if (!sender) return // console bypasses toggles and blocks

  const match = WHISPER.exec(event.getInput())
  if (!match) return

  // ponytail: selectors (@p, @a) skip the checks below, vanilla handles them
  const target = sender.server.getPlayerList().getPlayerByName(match[1])
  if (target) {
    const targetName = playerName(target)

    if (getBlocks(target)[playerName(sender).toLowerCase()] !== undefined) {
      sender.tell(Component.red(targetName + " has blocked you."))
      event.cancel()
      return
    }

    if (pmsDisabled(target)) {
      sender.tell(Component.red(targetName + " has private messages disabled."))
      event.cancel()
      return
    }

    setLastPartner(target, playerName(sender))
  }

  setLastPartner(sender, match[1])
})

ServerEvents.commandRegistry(event => {
  const { commands: Commands, arguments: Arguments } = event

  function reply(ctx) {
    const player = ctx.getSource().getPlayer()
    if (!player) return 0

    const target = getLastPartner(player)
    if (!target) {
      player.tell(Component.red("Nobody to reply to - use /msg <player> <message> first."))
      return 0
    }

    player.runCommand("msg " + target + " " + Arguments.GREEDY_STRING.getResult(ctx, "message"))
    return 1
  }

  function toggle(ctx) {
    const player = ctx.getSource().getPlayer()
    if (!player) return 0

    const off = !pmsDisabled(player)
    player.persistentData.putBoolean(TOGGLE_KEY, off)
    player.tell(off
      ? Component.yellow("Private messages are now OFF - nobody can message you.")
      : Component.green("Private messages are now ON."))
    return 1
  }

  function targetName(ctx) {
    const profiles = Arguments.GAME_PROFILE.getResult(ctx, "player").toArray()
    return profiles.length ? str(profiles[0].getName()) : null
  }

  function block(ctx, reason) {
    const player = ctx.getSource().getPlayer()
    if (!player) return 0

    const name = targetName(ctx)
    if (!name) {
      player.tell(Component.red("Player not found."))
      return 0
    }
    if (name.toLowerCase() == playerName(player).toLowerCase()) {
      player.tell(Component.red("You cannot block yourself."))
      return 0
    }

    const blocks = getBlocks(player)
    blocks[name.toLowerCase()] = reason || ""
    setBlocks(player, blocks)
    player.tell(Component.green("Blocked " + name + (reason ? " (" + reason + ")" : "") + "."))
    return 1
  }

  function unblock(ctx) {
    const player = ctx.getSource().getPlayer()
    if (!player) return 0

    const name = targetName(ctx)
    if (!name) {
      player.tell(Component.red("Player not found."))
      return 0
    }

    const blocks = getBlocks(player)
    if (blocks[name.toLowerCase()] === undefined) {
      player.tell(Component.red(name + " is not blocked."))
      return 0
    }

    delete blocks[name.toLowerCase()]
    setBlocks(player, blocks)
    player.tell(Component.green("Unblocked " + name + "."))
    return 1
  }

  function blocklist(ctx) {
    const player = ctx.getSource().getPlayer()
    if (!player) return 0

    const blocks = getBlocks(player)
    const names = Object.keys(blocks)
    if (names.length == 0) {
      player.tell(Component.yellow("You have nobody blocked."))
      return 0
    }

    let msg = Component.gold("Blocked players (" + names.length + "):")
    for (const name of names) {
      msg = msg.append("\n").append(Component.white("- " + name))
        .append(blocks[name] ? Component.gray(" (" + blocks[name] + ")") : Component.white(""))
    }
    player.tell(msg)
    return 1
  }

  for (const name of ["re", "r"]) {
    event.register(
      Commands.literal(name)
        .then(Commands.argument("message", Arguments.GREEDY_STRING.create(event))
          .executes(ctx => reply(ctx)))
    )
  }

  event.register(Commands.literal("msgtoggle").executes(ctx => toggle(ctx)))
  event.register(Commands.literal("blocklist").executes(ctx => blocklist(ctx)))

  event.register(
    Commands.literal("block")
      .then(Commands.argument("player", Arguments.GAME_PROFILE.create(event))
        .executes(ctx => block(ctx, null))
        .then(Commands.argument("reason", Arguments.GREEDY_STRING.create(event))
          .executes(ctx => block(ctx, Arguments.GREEDY_STRING.getResult(ctx, "reason")))))
  )

  event.register(
    Commands.literal("unblock")
      .then(Commands.argument("player", Arguments.GAME_PROFILE.create(event))
        .executes(ctx => unblock(ctx)))
  )
})

})()
