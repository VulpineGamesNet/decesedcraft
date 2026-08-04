// Periodic server announcements (DeceasedCraft, MC 1.20.1 / KubeJS 2001.6.5).
// Messages are plain tellraw JSON, so anything vanilla tellraw supports works:
// colors, bold/italic, hover text, clickable links and commands.
// To change: edit ANNOUNCE_INTERVAL_MINUTES / MESSAGES below, then run
// `kubejs reload server-scripts` (no restart needed - no commands registered).

// Wrapped in an IIFE: KubeJS server scripts all share one global scope.
(function () {

// ============================================================================
// CONFIGURATION
// ============================================================================

const ANNOUNCE_INTERVAL_MINUTES = 120

// Don't talk to an empty server.
const ONLY_WHEN_PLAYERS_ONLINE = true

// Shown one after another, looping. Each entry is a list of tellraw components.
const MESSAGES = [
  [
    { text: "[Vote] ", color: "gold", bold: true },
    { text: "Vote daily for ", color: "white" },
    { text: "free coins", color: "green", bold: true },
    { text: " - streaks pay up to ", color: "white" },
    { text: "3x", color: "green", bold: true },
    { text: "!\n", color: "white" },
    // Clickable without the underline: clickEvent and "underlined" are separate
    // fields, and components are never auto-underlined the way typed URLs are.
    {
      text: "/vote", color: "aqua", bold: true,
      clickEvent: { action: "run_command", value: "/vote" },
      hoverEvent: { action: "show_text", contents: "Click to run /vote" }
    }
  ],
  [
    { text: "[Wallet] ", color: "green", bold: true },
    { text: "Trade with other survivors at sign shops.\n", color: "white" },
    {
      text: "/wallet help", color: "aqua", bold: true,
      clickEvent: { action: "run_command", value: "/wallet help" },
      hoverEvent: { action: "show_text", contents: "Click to run /wallet help" }
    }
  ],
  [
    { text: "[Discord] ", color: "blue", bold: true },
    { text: "News, updates and support on our Discord.\n", color: "white" },
    {
      text: "/discord", color: "aqua", bold: true,
      clickEvent: { action: "run_command", value: "/discord" },
      hoverEvent: { action: "show_text", contents: "Click to run /discord" }
    }
  ]
]

// ============================================================================

const INTERVAL_TICKS = Math.max(1, Math.round(ANNOUNCE_INTERVAL_MINUTES * 60 * 20))
let nextMessage = 0

ServerEvents.tick(event => {
  const server = event.server
  const tick = server.getTickCount()
  if (tick <= 0 || tick % INTERVAL_TICKS !== 0) return
  if (ONLY_WHEN_PLAYERS_ONLINE && server.getPlayerList().getPlayers().isEmpty()) return

  const message = MESSAGES[nextMessage % MESSAGES.length]
  nextMessage++

  // Leading "" so the first component's style isn't inherited by the rest.
  server.runCommandSilent('tellraw @a ' + JSON.stringify([""].concat(message)))
})

})()
