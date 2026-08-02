// /discord (alias /dc) - print the community Discord invite
// Target: Minecraft 1.20.1 / Forge / KubeJS 2001.6.x
//
// Wrapped in an IIFE because all server_scripts/*.js share one global scope
// and DeceasedCraft ships its own scripts.

;(function () {

  const DISCORD_URL = "https://discord.gg/TYEtKS4GZt"

  function buildDiscordMessage() {
    const link = Component.aqua(DISCORD_URL)
      .underlined()
      .clickOpenUrl(DISCORD_URL)
      .hover(Component.yellow("Click to open Discord"))

    return Component.gold("============== Vulpine Discord ==============")
      .append("\n")
      .append(Component.white("Join our discord: ").append(link))
      .append("\n")
      .append(Component.gold("=========================================="))
  }

  function replyToInvoker(ctx) {
    const msg = buildDiscordMessage()
    const player = ctx.getSource().getPlayer()

    if (player) {
      // Only the player who ran the command
      player.tell(msg)
    } else {
      // Console / command block / RCON
      ctx.getSource().sendSystemMessage(msg)
    }
    return 1
  }

  ServerEvents.commandRegistry(event => {
    let Commands = event.getCommands()

    event.register(Commands.literal("dc").executes(function (ctx) {
      return replyToInvoker(ctx)
    }))
    event.register(Commands.literal("discord").executes(function (ctx) {
      return replyToInvoker(ctx)
    }))
  })

  console.info("[Discord] /discord and /dc commands registered")

})()
