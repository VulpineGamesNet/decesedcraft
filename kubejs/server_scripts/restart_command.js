// /srestart - schedule a server shutdown with countdown warnings
// Target: Minecraft 1.20.1 / Forge / KubeJS 2001.6.x
//
// NOTE: this issues vanilla `stop`. This server's startup command runs java
// directly with no wrapper loop, so the process exits and stays down until it
// is started again from the panel. The countdown and warnings are the point;
// the "restart" only completes if something restarts the container.
//
// Wrapped in an IIFE because all server_scripts/*.js share one global scope
// and DeceasedCraft ships its own scripts.

;(function () {

  // Track restart state
  let restartScheduled = false
  let restartCancelled = false
  let restartId = 0
  let restartTargetTick = 0

  // Warning intervals in seconds (only applicable ones will be used)
  const WARNING_INTERVALS = [
    { seconds: 600, message: '10 minutes' },
    { seconds: 300, message: '5 minutes' },
    { seconds: 120, message: '2 minutes' },
    { seconds: 60, message: '1 minute' },
    { seconds: 30, message: '30 seconds' },
    { seconds: 10, message: '10 seconds' },
    { seconds: 9, message: '9 seconds' },
    { seconds: 8, message: '8 seconds' },
    { seconds: 7, message: '7 seconds' },
    { seconds: 6, message: '6 seconds' },
    { seconds: 5, message: '5 seconds' },
    { seconds: 4, message: '4 seconds' },
    { seconds: 3, message: '3 seconds' },
    { seconds: 2, message: '2 seconds' },
    { seconds: 1, message: '1 second' }
  ]

  // Broadcast message to all players and console
  function broadcastMessage(server, component) {
    server.getPlayers().forEach(function (player) {
      player.sendSystemMessage(component)
    })
    server.sendSystemMessage(component)
  }

  function buildWarningMessage(timeText) {
    return Component.red('[Server] ').bold()
      .append(Component.yellow('Restarting in '))
      .append(Component.red(timeText).bold())
  }

  // Final ten seconds are just the number
  function buildCountdownMessage(seconds) {
    return Component.red('[Server] ').bold()
      .append(Component.red(String(seconds)).bold())
  }

  function scheduleRestart(server, minutes, currentRestartId) {
    let totalSeconds = minutes * 60
    let totalTicks = totalSeconds * 20

    WARNING_INTERVALS.forEach(function (warning) {
      if (warning.seconds <= totalSeconds) {
        let ticksUntilWarning = (totalSeconds - warning.seconds) * 20
        server.scheduleInTicks(ticksUntilWarning, function () {
          // A newer schedule or a cancel supersedes this callback
          if (restartCancelled || restartId !== currentRestartId) return
          let msg = warning.seconds <= 10
            ? buildCountdownMessage(warning.seconds)
            : buildWarningMessage(warning.message)
          broadcastMessage(server, msg)
        })
      }
    })

    server.scheduleInTicks(totalTicks, function () {
      if (restartCancelled || restartId !== currentRestartId) return
      broadcastMessage(server, Component.red('[Server] ').bold().append(Component.red('Restarting now!').bold()))
      server.runCommandSilent('stop')
    })

    let msg = Component.green('[Server] ').bold()
      .append(Component.yellow('Server restart scheduled in '))
      .append(Component.green(minutes + (minutes === 1 ? ' minute' : ' minutes')).bold())
    broadcastMessage(server, msg)

    restartScheduled = true
    restartTargetTick = server.getTickCount() + totalTicks
    console.info('[Restart] Server restart scheduled in ' + minutes + ' minutes')
  }

  function cancelRestart(server) {
    if (!restartScheduled) {
      return false
    }

    restartCancelled = true
    restartScheduled = false
    restartTargetTick = 0

    broadcastMessage(server, Component.green('[Server] ').bold()
      .append(Component.yellow('Server restart has been '))
      .append(Component.green('cancelled').bold()))

    console.info('[Restart] Server restart cancelled')
    return true
  }

  ServerEvents.commandRegistry(event => {
    let Commands = event.getCommands()
    let Arguments = event.getArguments()

    event.register(
      Commands.literal('srestart')
        .requires(function (src) {
          return src.hasPermission(2)
        })
        .executes(function (ctx) {
          let src = ctx.getSource()
          src.sendSystemMessage(Component.gold('=== Server Restart Commands ==='))
          src.sendSystemMessage(Component.yellow('/srestart <minutes>').append(Component.gray(' - Schedule restart')))
          src.sendSystemMessage(Component.yellow('/srestart cancel').append(Component.gray(' - Cancel scheduled restart')))
          src.sendSystemMessage(Component.yellow('/srestart info').append(Component.gray(' - Check restart status')))
          return 1
        })
        .then(
          Commands.literal('cancel')
            .executes(function (ctx) {
              let server = ctx.getSource().getServer()
              if (cancelRestart(server)) {
                return 1
              }
              ctx.getSource().sendSystemMessage(Component.red('No restart is currently scheduled.'))
              return 0
            })
        )
        .then(
          Commands.literal('info')
            .executes(function (ctx) {
              let server = ctx.getSource().getServer()
              if (!restartScheduled) {
                ctx.getSource().sendSystemMessage(Component.yellow('No restart is currently scheduled.'))
                return 1
              }

              let ticksRemaining = restartTargetTick - server.getTickCount()
              if (ticksRemaining <= 0) {
                ctx.getSource().sendSystemMessage(Component.yellow('Restart is imminent.'))
                return 1
              }

              let secondsRemaining = Math.floor(ticksRemaining / 20)
              let minutes = Math.floor(secondsRemaining / 60)
              let seconds = secondsRemaining % 60

              let timeText
              if (minutes > 0) {
                timeText = minutes + (minutes === 1 ? ' minute' : ' minutes')
                if (seconds > 0) {
                  timeText += ' ' + seconds + (seconds === 1 ? ' second' : ' seconds')
                }
              } else {
                timeText = seconds + (seconds === 1 ? ' second' : ' seconds')
              }

              ctx.getSource().sendSystemMessage(
                Component.gold('[Server] ').bold()
                  .append(Component.yellow('Restart scheduled in '))
                  .append(Component.red(timeText).bold())
              )
              return 1
            })
        )
        .then(
          Commands.argument('minutes', Arguments.INTEGER.create(event))
            .executes(function (ctx) {
              let minutes = Arguments.INTEGER.getResult(ctx, 'minutes')

              if (minutes < 1) {
                ctx.getSource().sendSystemMessage(Component.red('Minutes must be at least 1.'))
                return 0
              }
              let server = ctx.getSource().getServer()

              // Supersede any existing schedule
              if (restartScheduled) {
                restartCancelled = true
                restartScheduled = false
                ctx.getSource().sendSystemMessage(Component.yellow('Previous restart cancelled.'))
              }

              restartCancelled = false
              restartId++

              scheduleRestart(server, minutes, restartId)
              return 1
            })
        )
    )
  })

  console.info('[Restart] /srestart command registered')

})()
