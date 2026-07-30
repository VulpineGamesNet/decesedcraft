// DeceasedCraft port (MC 1.20.1, Forge, KubeJS 2001.6.5). Same behaviour as the ATM10 copy.
// Playtime Command clone:
//   /playtime                 your own playtime
//   /playtime <player>        another online player's playtime
//   /playtime --top [page]    online players leaderboard
//   /playtime --help          usage
// Reads the vanilla minecraft:play_time statistic, so numbers match F3 / the
// in-game statistics screen and nothing extra is stored.
// ponytail: leaderboard covers online players only, same as the plugin.

// Wrapped in an IIFE: KubeJS server scripts all share one global scope.
(function () {

const PER_PAGE = 10

function playTicks(player) {
  return player.getStats().getPlayTime() // KubeJS PlayerStatsJS, reads minecraft:play_time
}

const UNITS = [
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1]
]

function formatTicks(ticks) {
  let seconds = Math.floor(Number(ticks) / 20)

  const parts = []
  for (const unit of UNITS) {
    // let, not const: KubeJS' Rhino silently fails to redeclare a const inside
    // a loop body, so every iteration after the first would be skipped.
    let amount = Math.floor(seconds / unit[1])
    seconds -= amount * unit[1]
    if (amount) parts.push(amount + " " + unit[0] + (amount == 1 ? "" : "s"))
  }

  if (parts.length == 0) return "0 seconds"
  if (parts.length == 1) return parts[0]
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1]
}

function tell(ctx, component) {
  const player = ctx.getSource().getPlayer()
  if (player) player.tell(component)
  else ctx.getSource().sendSystemMessage(component)
  return 1
}

ServerEvents.commandRegistry(event => {
  const { commands: Commands, arguments: Arguments } = event

  function show(ctx, player, self) {
    return tell(ctx, Component.gold(self ? "You have played for " : player.getName().getString() + " has played for ")
      .append(Component.yellow(formatTicks(playTicks(player))).bold()))
  }

  function showSelf(ctx) {
    const player = ctx.getSource().getPlayer()
    if (!player) return tell(ctx, Component.red("Console has no playtime - use /playtime <player>."))
    return show(ctx, player, true)
  }

  function showOther(ctx) {
    return show(ctx, Arguments.PLAYER.getResult(ctx, "player"), false)
  }

  function top(ctx, page) {
    const online = ctx.getSource().getServer().getPlayerList().getPlayers()
    const players = []
    for (let i = 0; i < online.size(); i++) players.push(online.get(i))
    if (players.length == 0) return tell(ctx, Component.red("Nobody is online."))

    players.sort((a, b) => playTicks(b) - playTicks(a))

    const pages = Math.ceil(players.length / PER_PAGE)
    if (page < 1) page = 1
    if (page > pages) page = pages
    const start = (page - 1) * PER_PAGE

    let msg = Component.gold("=== Playtime (online) - page " + page + "/" + pages + " ===")
    for (let i = start; i < Math.min(start + PER_PAGE, players.length); i++) {
      msg = msg.append("\n")
        .append(Component.yellow("#" + (i + 1) + " ").bold())
        .append(Component.white(players[i].getName().getString() + " - "))
        .append(Component.green(formatTicks(playTicks(players[i]))))
    }
    return tell(ctx, msg)
  }

  function help(ctx) {
    return tell(ctx, Component.gold("=== Playtime Help ===")
      .append("\n").append(Component.white("/playtime - your playtime"))
      .append("\n").append(Component.white("/playtime <player> - another online player's playtime"))
      .append("\n").append(Component.white("/playtime --top [page] - online leaderboard")))
  }

  event.register(
    Commands.literal("playtime")
      .executes(ctx => showSelf(ctx))
      .then(Commands.literal("--help").executes(ctx => help(ctx)))
      .then(Commands.literal("--top")
        .executes(ctx => top(ctx, 1))
        .then(Commands.argument("page", Arguments.INTEGER.create(event))
          .executes(ctx => top(ctx, Arguments.INTEGER.getResult(ctx, "page")))))
      .then(Commands.argument("player", Arguments.PLAYER.create(event))
        .executes(ctx => showOther(ctx)))
  )
})

})()
