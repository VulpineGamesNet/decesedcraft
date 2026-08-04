// Periodic server announcements (DeceasedCraft, MC 1.20.1 / KubeJS 2001.6.5).
// Fires on wall-clock slots (every ANNOUNCE_INTERVAL_MINUTES since the epoch),
// so restarts don't shift the schedule.
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

const INTERVAL_MS = Math.max(60000, Math.round(ANNOUNCE_INTERVAL_MINUTES * 60 * 1000))
// Slots are counted off the wall clock, not the tick counter, so a restart
// never shifts the schedule and never repeats a slot it already announced.
// Boundaries sit on the UTC epoch grid: 120 min lands on even UTC hours.
let lastSlot = -1

ServerEvents.tick(event => {
  const server = event.server
  if (server.getTickCount() % 20 !== 0) return // checking once a second is precise enough

  const slot = Math.floor(new Date().getTime() / INTERVAL_MS)
  if (slot === lastSlot) return

  const firstCheck = lastSlot < 0
  lastSlot = slot
  if (firstCheck) return // script just (re)loaded mid-slot - don't announce for it
  if (ONLY_WHEN_PLAYERS_ONLINE && server.getPlayerList().getPlayers().isEmpty()) return

  // Which message shows follows the slot number, so the rotation stays put
  // across restarts instead of starting over at the first message.
  const message = MESSAGES[slot % MESSAGES.length]

  // Leading "" so the first component's style isn't inherited by the rest.
  server.runCommandSilent('tellraw @a ' + JSON.stringify([""].concat(message)))
})

})()
