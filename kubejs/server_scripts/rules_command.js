// /rules - display the server rules
// Target: Minecraft 1.20.1 / Forge / KubeJS 2001.6.x
//
// Wrapped in an IIFE because all server_scripts/*.js share one global scope
// and DeceasedCraft ships its own scripts.

;(function () {

  const RULES = [
    "Intentionally lagging or crashing the server is prohibited",
    "Place multiblock machines within a single chunk",
    "English only in chat - so everyone can join the conversation",
    "No griefing - don't damage builds or harm players intentionally",
    "Be kind - no harassment, hate speech, or bullying",
    "No advertising other servers or communities",
    "Keep chat PG-13 - watch your language",
    "Laggy builds will receive a warning to optimize"
  ]

  function buildRulesMessage() {
    let msg = Component.gold("==================== Rules ====================")

    for (let i = 0; i < RULES.length; i++) {
      msg = msg
        .append("\n")
        .append(Component.yellow((i + 1) + ". ").bold())
        .append(Component.white(RULES[i]))
    }

    return msg.append("\n").append(
      Component.gold("===============================================")
    )
  }

  function replyToInvoker(ctx) {
    const msg = buildRulesMessage()
    const player = ctx.getSource().getPlayer()

    if (player) {
      player.tell(msg)
    } else {
      ctx.getSource().sendSystemMessage(msg)
    }
    return 1
  }

  ServerEvents.commandRegistry(event => {
    let Commands = event.getCommands()

    event.register(Commands.literal("rules").executes(function (ctx) {
      return replyToInvoker(ctx)
    }))
  })

  console.info("[Rules] /rules command registered (" + RULES.length + " rules)")

})()
