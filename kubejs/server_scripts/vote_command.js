// KubeVote - voting rewards
// Target: Minecraft 1.20.1 / Forge / KubeJS 2001.6.x
//
// Ported from the ATM10 script. Rewards are KubeShop coins, same as ATM10; the
// only item-level difference is 1.20.1 NBT instead of 1.21 data components.
//
// Integrates with the votifier service via /kubevote process and claimqueue.
// Wrapped in an IIFE: all server_scripts/*.js share one global scope.

;(function () {

// KubeVote - Voting System with Rewards, Streaks, and Leaderboard (MySQL Version)
// Integrates with external Votifier service via /kubevote process command

// ============================================================================
// MYSQL CONFIGURATION - Read from config file
// ============================================================================

// Load config from kubejs/config/kubevote.json
let voteDbConfig = {}
try {
  voteDbConfig = JsonIO.read('kubejs/config/kubevote.json') || {}
} catch (e) {
  console.warn('[KubeVote] Could not load config file, using defaults: ' + e)
}

const VOTE_DB_HOST = voteDbConfig.host || 'localhost'
const VOTE_DB_PORT = parseInt(voteDbConfig.port || '3306')
const VOTE_DB_NAME = voteDbConfig.database || 'minecraft'
const VOTE_DB_USER = voteDbConfig.user || 'root'
const VOTE_DB_PASS = voteDbConfig.password || ''

// ============================================================================
// MYSQL CONNECTION
// ============================================================================

let VoteSqlTypes = Java.loadClass('java.sql.Types')

// Use MySQL driver directly to bypass DriverManager restrictions
let VoteMysqlDriver = Java.loadClass('com.mysql.cj.jdbc.Driver')
let voteMysqlDriver = new VoteMysqlDriver()

function getVoteConnection() {
  let url = 'jdbc:mysql://' + VOTE_DB_HOST + ':' + VOTE_DB_PORT + '/' + VOTE_DB_NAME +
    '?user=' + encodeURIComponent(VOTE_DB_USER) +
    '&password=' + encodeURIComponent(VOTE_DB_PASS) +
    '&autoReconnect=true'
  return voteMysqlDriver.connect(url, null)
}

function voteCloseQuietly(resource) {
  if (resource) {
    try { resource.close() } catch(e) {}
  }
}

// Track database availability
let voteDatabaseAvailable = false

// Initialize database tables on script load
function initVoteDatabase() {
  let conn = null
  let stmt = null
  try {
    console.info('[KubeVote] Connecting to database at ' + VOTE_DB_HOST + ':' + VOTE_DB_PORT + '/' + VOTE_DB_NAME + '...')
    conn = getVoteConnection()
    stmt = conn.createStatement()

    // Create players table
    stmt.executeUpdate(
      'CREATE TABLE IF NOT EXISTS kubevote_players (' +
      '  uuid VARCHAR(36) PRIMARY KEY,' +
      '  streak_count INT NOT NULL DEFAULT 0,' +
      '  streak_last_date VARCHAR(10),' +
      '  total_votes INT NOT NULL DEFAULT 0,' +
      '  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' +
      ')'
    )

    // Create site votes table (last vote timestamps per site)
    stmt.executeUpdate(
      'CREATE TABLE IF NOT EXISTS kubevote_site_votes (' +
      '  uuid VARCHAR(36) NOT NULL,' +
      '  site_id VARCHAR(100) NOT NULL,' +
      '  last_vote BIGINT NOT NULL,' +
      '  PRIMARY KEY (uuid, site_id)' +
      ')'
    )

    // Create leaderboard table
    stmt.executeUpdate(
      'CREATE TABLE IF NOT EXISTS kubevote_leaderboard (' +
      '  month VARCHAR(7) NOT NULL,' +
      '  uuid VARCHAR(36) NOT NULL,' +
      '  votes INT NOT NULL DEFAULT 0,' +
      '  PRIMARY KEY (month, uuid)' +
      ')'
    )

    voteDatabaseAvailable = true
    console.info('[KubeVote] Database tables initialized successfully')
  } catch(e) {
    voteDatabaseAvailable = false
    console.error('[KubeVote] ========================================')
    console.error('[KubeVote] FAILED TO CONNECT TO DATABASE!')
    console.error('[KubeVote] Error: ' + e)
    console.error('[KubeVote] Host: ' + VOTE_DB_HOST + ':' + VOTE_DB_PORT + '/' + VOTE_DB_NAME)
    console.error('[KubeVote] User: ' + VOTE_DB_USER)
    console.error('[KubeVote] KubeVote features will be DISABLED')
    console.error('[KubeVote] ========================================')
  } finally {
    voteCloseQuietly(stmt)
    voteCloseQuietly(conn)
  }
}

// Initialize database on script load
initVoteDatabase()

// ============================================================================
// CONFIGURATION
// ============================================================================

// Voting sites configuration
// id: must match the service name sent by voting sites
// cooldown: display cooldown in milliseconds (86400000 = 24 hours) - for UI only
// hidden: if true, site won't appear in /vote list but still processes votes
// `id` must match the service name the site sends to the votifier listener on
// port 8193, which is NOT always the domain - confirm each new entry against the
// votifier log line "Received vote:" after a test vote. A vote from an unknown
// id is still rewarded, it just is not tracked per site.
const VOTING_SITES = [
  {
    id: "moddedminecraftservers.com",
    name: "Modded MC Servers",
    url: "https://moddedminecraftservers.com/server/vulpine-decesed-craft.61046/",
    cooldown: 86400000
  },
  {
    id: "minestatus.net_test_vote",
    name: "MineStatus Test",
    url: "https://minestatus.net/",
    cooldown: 86400000,
    hidden: true
  }
]

// Reward configuration - Physical coins (gold_nugget with custom_model_data)
// Base reward is 1x $100 coin, streak multipliers add more coins
// Remainder is given as $10 coins
const STREAK_BONUSES = [
  { days: 3, multiplier: 1.5, name: "3-day streak" },    // 1x $100 + 5x $10 = $150
  { days: 7, multiplier: 2.0, name: "Weekly streak" },   // 2x $100 = $200
  { days: 14, multiplier: 2.5, name: "2-week streak" },  // 2x $100 + 5x $10 = $250
  { days: 30, multiplier: 3.0, name: "Monthly streak" }  // 3x $100 = $300
]

// Coin item configurations
const COIN_100 = {
  id: "minecraft:gold_nugget",
  customModelData: 719100,
  value: 100,
  name: '{"text":"Coin","color":"blue","italic":false}',
  lore: '{"text":"Worth $100","color":"gray","italic":false}'
}

const COIN_10 = {
  id: "minecraft:gold_nugget",
  customModelData: 719010,
  value: 10,
  name: '{"text":"Coin","color":"green","italic":false}',
  lore: '{"text":"Worth $10","color":"gray","italic":false}'
}

// ============================================================================
// DATA MANAGEMENT - MySQL Functions
// ============================================================================

let voteDataCache = {}
let leaderboardCache = { month: "", votes: {} }
let dataLoaded = false
let claimQueue = []  // Queue for pending claim requests

function ensureDataLoaded(server) {
  if (!voteDatabaseAvailable) return
  if (dataLoaded) return

  console.info("[KubeVote] Loading data from database...")
  loadVoteData(server)
  loadLeaderboard(server)
  dataLoaded = true
}

function loadVoteData(server) {
  if (!voteDatabaseAvailable) return

  let conn = null
  let stmt = null
  let rs = null
  try {
    conn = getVoteConnection()
    voteDataCache = {}

    // Load player data
    stmt = conn.prepareStatement('SELECT * FROM kubevote_players')
    rs = stmt.executeQuery()

    let playerCount = 0
    while (rs.next()) {
      let uuid = rs.getString('uuid')
      voteDataCache[uuid] = {
        lastVotes: {},
        streak: {
          count: rs.getInt('streak_count'),
          lastDate: rs.getString('streak_last_date') || ""
        },
        totalVotes: rs.getInt('total_votes')
      }
      playerCount++
    }
    voteCloseQuietly(rs)
    voteCloseQuietly(stmt)

    // Load site votes for each player
    stmt = conn.prepareStatement('SELECT * FROM kubevote_site_votes')
    rs = stmt.executeQuery()

    while (rs.next()) {
      let uuid = rs.getString('uuid')
      let siteId = rs.getString('site_id')
      let lastVote = rs.getLong('last_vote')

      if (voteDataCache[uuid]) {
        voteDataCache[uuid].lastVotes[siteId] = lastVote
      }
    }

    console.info("[KubeVote] Loaded vote data for " + playerCount + " players")
  } catch(e) {
    console.error('[KubeVote] loadVoteData error: ' + e)
  } finally {
    voteCloseQuietly(rs)
    voteCloseQuietly(stmt)
    voteCloseQuietly(conn)
  }
}

function savePlayerVoteData(server, uuid) {
  if (!voteDatabaseAvailable) return

  let data = voteDataCache[uuid]
  if (!data) return

  let conn = null
  let stmt = null
  try {
    conn = getVoteConnection()

    // Upsert player data
    stmt = conn.prepareStatement(
      'INSERT INTO kubevote_players (uuid, streak_count, streak_last_date, total_votes) ' +
      'VALUES (?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE streak_count = ?, streak_last_date = ?, total_votes = ?'
    )
    stmt.setString(1, uuid)
    stmt.setInt(2, data.streak.count)
    stmt.setString(3, data.streak.lastDate)
    stmt.setInt(4, data.totalVotes)
    stmt.setInt(5, data.streak.count)
    stmt.setString(6, data.streak.lastDate)
    stmt.setInt(7, data.totalVotes)
    stmt.executeUpdate()
    voteCloseQuietly(stmt)

    // Upsert site votes
    for (let siteId in data.lastVotes) {
      stmt = conn.prepareStatement(
        'INSERT INTO kubevote_site_votes (uuid, site_id, last_vote) ' +
        'VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE last_vote = ?'
      )
      stmt.setString(1, uuid)
      stmt.setString(2, siteId)
      stmt.setLong(3, data.lastVotes[siteId])
      stmt.setLong(4, data.lastVotes[siteId])
      stmt.executeUpdate()
      voteCloseQuietly(stmt)
    }
  } catch(e) {
    console.error('[KubeVote] savePlayerVoteData error: ' + e)
  } finally {
    voteCloseQuietly(stmt)
    voteCloseQuietly(conn)
  }
}

function loadLeaderboard(server) {
  if (!voteDatabaseAvailable) return

  let currentMonth = getCurrentMonthString()
  leaderboardCache = { month: currentMonth, votes: {} }

  let conn = null
  let stmt = null
  let rs = null
  try {
    conn = getVoteConnection()
    stmt = conn.prepareStatement('SELECT uuid, votes FROM kubevote_leaderboard WHERE month = ?')
    stmt.setString(1, currentMonth)
    rs = stmt.executeQuery()

    while (rs.next()) {
      leaderboardCache.votes[rs.getString('uuid')] = rs.getInt('votes')
    }

    console.info("[KubeVote] Loaded leaderboard for " + currentMonth + " (" + Object.keys(leaderboardCache.votes).length + " entries)")
  } catch(e) {
    console.error('[KubeVote] loadLeaderboard error: ' + e)
  } finally {
    voteCloseQuietly(rs)
    voteCloseQuietly(stmt)
    voteCloseQuietly(conn)
  }
}

function saveLeaderboard(server) {
  if (!voteDatabaseAvailable) return

  let conn = null
  let stmt = null
  try {
    conn = getVoteConnection()

    for (let uuid in leaderboardCache.votes) {
      stmt = conn.prepareStatement(
        'INSERT INTO kubevote_leaderboard (month, uuid, votes) ' +
        'VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE votes = ?'
      )
      stmt.setString(1, leaderboardCache.month)
      stmt.setString(2, uuid)
      stmt.setInt(3, leaderboardCache.votes[uuid])
      stmt.setInt(4, leaderboardCache.votes[uuid])
      stmt.executeUpdate()
      voteCloseQuietly(stmt)
    }
  } catch(e) {
    console.error('[KubeVote] saveLeaderboard error: ' + e)
  } finally {
    voteCloseQuietly(stmt)
    voteCloseQuietly(conn)
  }
}

function deletePlayerVoteData(server, uuid) {
  if (!voteDatabaseAvailable) return

  let conn = null
  let stmt = null
  try {
    conn = getVoteConnection()

    // Delete from site_votes
    stmt = conn.prepareStatement('DELETE FROM kubevote_site_votes WHERE uuid = ?')
    stmt.setString(1, uuid)
    stmt.executeUpdate()
    voteCloseQuietly(stmt)

    // Delete from players
    stmt = conn.prepareStatement('DELETE FROM kubevote_players WHERE uuid = ?')
    stmt.setString(1, uuid)
    stmt.executeUpdate()
    voteCloseQuietly(stmt)

    // Delete from leaderboard (all months)
    stmt = conn.prepareStatement('DELETE FROM kubevote_leaderboard WHERE uuid = ?')
    stmt.setString(1, uuid)
    stmt.executeUpdate()
  } catch(e) {
    console.error('[KubeVote] deletePlayerVoteData error: ' + e)
  } finally {
    voteCloseQuietly(stmt)
    voteCloseQuietly(conn)
  }
}

function ensurePlayerData(uuid) {
  if (!voteDataCache[uuid]) {
    voteDataCache[uuid] = {
      lastVotes: {},
      streak: { count: 0, lastDate: "" },
      totalVotes: 0
    }
  }
  return voteDataCache[uuid]
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getCurrentDateString() {
  let now = new Date()
  let year = now.getFullYear()
  let month = (now.getMonth() + 1).toString().padStart(2, "0")
  let day = now.getDate().toString().padStart(2, "0")
  return year + "-" + month + "-" + day
}

function getCurrentMonthString() {
  let now = new Date()
  let year = now.getFullYear()
  let month = (now.getMonth() + 1).toString().padStart(2, "0")
  return year + "-" + month
}

function getYesterdayDateString() {
  let now = new Date()
  now.setDate(now.getDate() - 1)
  let year = now.getFullYear()
  let month = (now.getMonth() + 1).toString().padStart(2, "0")
  let day = now.getDate().toString().padStart(2, "0")
  return year + "-" + month + "-" + day
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return "Ready!"

  let hours = Math.floor(ms / 3600000)
  let minutes = Math.floor((ms % 3600000) / 60000)

  if (hours > 0) {
    return hours + "h " + minutes + "m"
  }
  return minutes + "m"
}

function getSiteById(siteId) {
  for (let i = 0; i < VOTING_SITES.length; i++) {
    if (VOTING_SITES[i].id.toLowerCase() === siteId.toLowerCase()) {
      return VOTING_SITES[i]
    }
  }
  return null
}

function getStreakMultiplier(streakCount) {
  let multiplier = 1.0
  let bonusName = null

  for (let i = STREAK_BONUSES.length - 1; i >= 0; i--) {
    if (streakCount >= STREAK_BONUSES[i].days) {
      multiplier = STREAK_BONUSES[i].multiplier
      bonusName = STREAK_BONUSES[i].name
      break
    }
  }

  return { multiplier: multiplier, name: bonusName }
}

function createCoinItem(coinConfig, count) {
  // 1.20.1 stores this as NBT; the 1.21 data-component syntax used on ATM10
  // does not exist here. Matches kubeshop.js createCoinItem() exactly, so a
  // voted coin and a withdrawn coin are the same item.
  let nbt = '{CustomModelData:' + coinConfig.customModelData + ',' +
    'display:{Name:\'' + coinConfig.name + '\',Lore:[\'' + coinConfig.lore + '\']}}'
  return Item.of(coinConfig.id, count, nbt)
}

function calculateCoinReward(multiplier) {
  // Base is 1x $100 coin = $100
  // Multiplier determines total value: 1.0 = $100, 1.5 = $150, 2.0 = $200, etc.
  let totalValue = Math.round(100 * multiplier)

  // Calculate how many $100 coins and $10 coins to give
  let coins100 = Math.floor(totalValue / 100)
  let remainder = totalValue % 100

  // Give $10 coins for the remainder
  let coins10 = Math.floor(remainder / 10)

  return {
    coins100: coins100,
    coins10: coins10,
    totalValue: (coins100 * 100) + (coins10 * 10)
  }
}

function giveCoinsToPlayer(player, coins100, coins10) {
  if (coins100 > 0) {
    let item100 = createCoinItem(COIN_100, coins100)
    player.give(item100)
  }
  if (coins10 > 0) {
    let item10 = createCoinItem(COIN_10, coins10)
    player.give(item10)
  }
  // Play reward sound
  playRewardSound(player)
}

function playRewardSound(player) {
  // Play a sparkly/sprinkling sound effect using playsound command
  player.server.runCommandSilent("playsound minecraft:block.amethyst_block.chime player " + player.getName().getString() + " ~ ~ ~ 1.0 1.0")
  // Add a second sound for more sparkle effect
  player.server.scheduleInTicks(3, () => {
    player.server.runCommandSilent("playsound minecraft:entity.experience_orb.pickup player " + player.getName().getString() + " ~ ~ ~ 0.5 1.2")
  })
}

function formatCoinReward(coins100, coins10) {
  let parts = []
  if (coins100 > 0) {
    parts.push(coins100 + "x $100")
  }
  if (coins10 > 0) {
    parts.push(coins10 + "x $10")
  }
  return parts.join(" + ")
}

// ============================================================================
// VOTE PROCESSING
// ============================================================================

function processVote(server, username, serviceId) {
  ensureDataLoaded(server)

  // Find player by username
  let player = server.getPlayerList().getPlayerByName(username)
  if (!player) {
    // Player offline - votifier service will save as pending reward
    console.info("[KubeVote] Player " + username + " is offline, vote saved as pending")
    return { success: false, message: "Player not found" }
  }

  let uuid = player.getStringUuid()
  let playerName = player.getName().getString()

  let site = getSiteById(serviceId)
  if (!site) {
    console.warn("[KubeVote] Unknown voting site: " + serviceId)
    // Still process the vote even if site is unknown
    site = { id: serviceId, name: serviceId, cooldown: 86400000 }
  }

  let data = ensurePlayerData(uuid)
  let today = getCurrentDateString()
  let yesterday = getYesterdayDateString()
  let currentMonth = getCurrentMonthString()

  // Update last vote time (for display purposes only)
  data.lastVotes[site.id] = Date.now()

  // Update streak
  if (data.streak.lastDate === yesterday) {
    data.streak.count++
  } else if (data.streak.lastDate !== today) {
    data.streak.count = 1
  }
  data.streak.lastDate = today

  // Update totals
  data.totalVotes++

  // Update leaderboard
  if (leaderboardCache.month !== currentMonth) {
    // New month, reset leaderboard
    leaderboardCache = { month: currentMonth, votes: {} }
    console.info("[KubeVote] New month - leaderboard reset")
  }
  leaderboardCache.votes[uuid] = (leaderboardCache.votes[uuid] || 0) + 1

  // Calculate reward - $100 and $50 coins based on streak multiplier
  let streakInfo = getStreakMultiplier(data.streak.count)
  let coinReward = calculateCoinReward(streakInfo.multiplier)

  // Save data
  savePlayerVoteData(server, uuid)
  saveLeaderboard(server)

  // Give reward - physical coins
  giveCoinsToPlayer(player, coinReward.coins100, coinReward.coins10)

  // Notify player
  player.tell(Component.gold("★ ").append(Component.yellow("Vote Reward")).append(Component.gold(" ★")))
  player.tell(
    Component.gray("  Thanks for voting on ")
      .append(Component.aqua(site.name))
      .append(Component.gray("!"))
  )

  // Reward breakdown
  let rewardMsg = Component.gray("  You received: ")
  if (coinReward.coins100 > 0) {
    rewardMsg.append(Component.blue(coinReward.coins100 + "x "))
      .append(Component.gold("$100 Coin"))
  }
  if (coinReward.coins100 > 0 && coinReward.coins10 > 0) {
    rewardMsg.append(Component.gray(" + "))
  }
  if (coinReward.coins10 > 0) {
    rewardMsg.append(Component.green(coinReward.coins10 + "x "))
      .append(Component.darkGreen("$10 Coin"))
  }
  player.tell(rewardMsg)

  player.tell(
    Component.gray("  Total: ")
      .append(Component.green("$" + coinReward.totalValue))
  )

  // Streak info
  let streakLine = Component.gray("  Streak: ")
    .append(Component.yellow(data.streak.count + " day" + (data.streak.count !== 1 ? "s" : "")))
  if (streakInfo.name) {
    streakLine.append(Component.gray(" ("))
      .append(Component.aqua(streakInfo.name))
      .append(Component.gray(")"))
  }
  player.tell(streakLine)

  player.tell(
    Component.gray("  Lifetime votes: ")
      .append(Component.yellow(data.totalVotes.toString()))
  )

  let coinDisplay = formatCoinReward(coinReward.coins100, coinReward.coins10)
  console.info("[KubeVote] Processed vote from " + playerName + " for " + site.name + " - reward: " + coinDisplay + " ($" + coinReward.totalValue + ") (streak: " + data.streak.count + " day" + (data.streak.count !== 1 ? "s" : "") + ")")

  return { success: true, coins100: coinReward.coins100, coins10: coinReward.coins10, value: coinReward.totalValue, streak: data.streak.count }
}

// ============================================================================
// SERVER EVENTS
// ============================================================================

ServerEvents.loaded(event => {
  dataLoaded = false
  voteDataCache = {}
  leaderboardCache = { month: "", votes: {} }
  ensureDataLoaded(event.server)
  console.info("[KubeVote] Vote system loaded")
})

// ============================================================================
// COMMANDS
// ============================================================================

ServerEvents.commandRegistry(event => {
  let Commands = event.getCommands()
  let Arguments = event.getArguments()

  // /vote - Show voting sites list
  event.register(
    Commands.literal("vote")
      .requires(src => {
        if (!voteDatabaseAvailable) {
          src.sendFailure(Component.red('[KubeVote] Database configuration is not loaded. Vote features are disabled.'))
          return false
        }
        return true
      })
      .executes(ctx => {
        let src = ctx.getSource()
        let player = src.getPlayer()

        if (!player) {
          src.sendFailure(Component.red("This command can only be used by players"))
          return 0
        }

        let server = src.getServer()
        ensureDataLoaded(server)

        let uuid = player.getStringUuid()
        let data = ensurePlayerData(uuid)
        let now = Date.now()

        src.sendSystemMessage(Component.gold("============ Vote for Rewards! ============"))
        src.sendSystemMessage(
          Component.gray("Click a green site name to open it in your browser.")
            .italic()
        )

        // Show each voting site with cooldown status
        for (let i = 0; i < VOTING_SITES.length; i++) {
          let site = VOTING_SITES[i]
          if (site.hidden) continue
          let lastVote = data.lastVotes[site.id] || 0
          let timeUntilReady = site.cooldown - (now - lastVote)

          let siteMsg = Component.empty()

          if (timeUntilReady <= 0) {
            // Ready to vote - needs attention, clickable link
            siteMsg.append(Component.red("✗ "))
              .append(
                Component.green(site.name)
                  .underlined()
                  .clickOpenUrl(site.url)
                  .hover(Component.yellow("Click to vote!"))
              )
          } else {
            // Already voted - checkmark with time remaining
            siteMsg.append(Component.green("✓ "))
              .append(Component.gray(site.name))
              .append(Component.gray(" (" + formatTimeRemaining(timeUntilReady) + ")"))
          }

          src.sendSystemMessage(siteMsg)
        }

        // Show streak and reward info
        let streakInfo = getStreakMultiplier(data.streak.count)
        let coinReward = calculateCoinReward(streakInfo.multiplier)

        src.sendSystemMessage(Component.gold("=========================================="))

        // Streak info
        let streakLine = Component.gray("Streak: ")
          .append(Component.yellow(data.streak.count + " day" + (data.streak.count !== 1 ? "s" : "")))

        if (streakInfo.name) {
          streakLine.append(Component.gray(" ("))
            .append(Component.aqua(streakInfo.name))
            .append(Component.gray(")"))
        }
        src.sendSystemMessage(streakLine)

        // Your next reward
        let rewardLine = Component.gray("Next reward: ")
        if (coinReward.coins100 > 0) {
          rewardLine.append(Component.blue(coinReward.coins100 + "x "))
            .append(Component.gold("$100"))
        }
        if (coinReward.coins100 > 0 && coinReward.coins10 > 0) {
          rewardLine.append(Component.gray(" + "))
        }
        if (coinReward.coins10 > 0) {
          rewardLine.append(Component.green(coinReward.coins10 + "x "))
            .append(Component.darkGreen("$10"))
        }
        rewardLine.append(Component.gray(" = "))
          .append(Component.green("$" + coinReward.totalValue))
        src.sendSystemMessage(rewardLine)

        return 1
      })

      // /vote list - Alias for /vote
      .then(Commands.literal("list")
        .executes(ctx => {
          // Just run the parent command
          return ctx.getSource().getServer().getCommands().getDispatcher()
            .execute("vote", ctx.getSource())
        })
      )

      // /vote stats [player] - Show vote statistics
      .then(Commands.literal("stats")
        .executes(ctx => {
          let player = ctx.getSource().getPlayer()
          if (!player) {
            ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
            return 0
          }

          return showVoteStats(ctx.getSource(), player.getStringUuid(), player.getName().getString())
        })
        .then(
          Commands.argument("player", Arguments.GAME_PROFILE.create(event))
            .requires(src => src.hasPermission(2))
            .executes(ctx => {
              let profiles = Arguments.GAME_PROFILE.getResult(ctx, "player")
              let profileArray = profiles.toArray()

              if (profileArray.length === 0) {
                ctx.getSource().sendFailure(Component.red("Player not found"))
                return 0
              }

              let profile = profileArray[0]
              return showVoteStats(ctx.getSource(), profile.getId().toString(), profile.getName())
            })
        )
      )

      // /vote top - Show leaderboard
      .then(Commands.literal("top")
        .executes(ctx => {
          let src = ctx.getSource()
          let server = src.getServer()
          ensureDataLoaded(server)

          let currentMonth = getCurrentMonthString()

          src.sendSystemMessage(Component.gold("========== Vote Leaderboard (" + currentMonth + ") =========="))

          if (leaderboardCache.month !== currentMonth || Object.keys(leaderboardCache.votes).length === 0) {
            src.sendSystemMessage(Component.gray("No votes recorded this month yet!"))
            return 1
          }

          // Sort by vote count
          let sorted = []
          for (let uuid in leaderboardCache.votes) {
            sorted.push({ uuid: uuid, votes: leaderboardCache.votes[uuid] })
          }
          sorted.sort(function(a, b) { return b.votes - a.votes })

          // Show top 10
          let toShow = Math.min(sorted.length, 10)
          for (let i = 0; i < toShow; i++) {
            let entry = sorted[i]
            let playerName = "Unknown"

            // Try to get player name
            let onlinePlayer = server.getPlayer(entry.uuid)
            if (onlinePlayer) {
              playerName = onlinePlayer.getName().getString()
            } else {
              try {
                let profileCache = server.getProfileCache()
                if (profileCache) {
                  let optProfile = profileCache.get(Java.loadClass('java.util.UUID').fromString(entry.uuid))
                  if (optProfile && optProfile.isPresent()) {
                    playerName = optProfile.get().getName()
                  }
                }
              } catch (e) {
                playerName = entry.uuid.substring(0, 8) + "..."
              }
            }

            let rankColor = i === 0 ? Component.gold : (i === 1 ? Component.gray : (i === 2 ? Component.darkRed : Component.white))
            let msg = Component.empty()
              .append(rankColor("#" + (i + 1) + " "))
              .append(Component.yellow(playerName))
              .append(Component.gray(" - "))
              .append(Component.green(entry.votes + " vote" + (entry.votes !== 1 ? "s" : "")))

            src.sendSystemMessage(msg)
          }

          return 1
        })
      )

      // /vote claim - Request pending rewards (votifier service handles actual claim)
      .then(Commands.literal("claim")
        .executes(ctx => {
          let src = ctx.getSource()
          let player = src.getPlayer()

          if (!player) {
            src.sendFailure(Component.red("This command can only be used by players"))
            return 0
          }

          let username = player.getName().getString()
          // Add to claim queue for votifier service to poll
          if (claimQueue.indexOf(username) === -1) {
            claimQueue.push(username)
          }
          ctx.getSource().sendSystemMessage(Component.gray("Checking for pending rewards..."))

          return 1
        })
      )
  )

  // /kubevote - Internal commands for Votifier service
  event.register(
    Commands.literal("kubevote")
      .requires(src => {
        if (!voteDatabaseAvailable) {
          src.sendFailure(Component.red('[KubeVote] Database configuration is not loaded. Vote features are disabled.'))
          return false
        }
        return src.hasPermission(2)
      })

      // /kubevote claimqueue - Get and clear pending claim requests (polled by votifier)
      .then(Commands.literal("claimqueue")
        .executes(ctx => {
          if (claimQueue.length === 0) {
            ctx.getSource().sendSystemMessage(Component.literal("CLAIMQUEUE:"))
            return 1
          }
          // Return queue as comma-separated list and clear it
          let result = claimQueue.join(",")
          claimQueue = []
          ctx.getSource().sendSystemMessage(Component.literal("CLAIMQUEUE:" + result))
          return 1
        })
      )

      // /kubevote claim <player> <count> - Give pending rewards (called by votifier service)
      .then(Commands.literal("claim")
        .then(
          Commands.argument("player", Arguments.STRING.create(event))
            .then(
              Commands.argument("count", Arguments.INTEGER.create(event))
                .executes(ctx => {
                  let playerName = Arguments.STRING.getResult(ctx, "player")
                  let count = Arguments.INTEGER.getResult(ctx, "count")
                  let server = ctx.getSource().getServer()

                  let player = server.getPlayerList().getPlayerByName(playerName)
                  if (!player) {
                    ctx.getSource().sendSystemMessage(Component.red("Player " + playerName + " not found or offline"))
                    return 0
                  }

                  if (count <= 0) {
                    player.tell(Component.yellow("You have no pending vote rewards."))
                    return 1
                  }

                  // Get player's streak for multiplier
                  ensureDataLoaded(server)
                  let uuid = player.getStringUuid()
                  let data = ensurePlayerData(uuid)
                  let streakInfo = getStreakMultiplier(data.streak.count)

                  // Calculate rewards with streak multiplier
                  let totalCoins100 = 0
                  let totalCoins10 = 0
                  for (let i = 0; i < count; i++) {
                    let coinReward = calculateCoinReward(streakInfo.multiplier)
                    totalCoins100 += coinReward.coins100
                    totalCoins10 += coinReward.coins10
                  }

                  // Give the coins
                  giveCoinsToPlayer(player, totalCoins100, totalCoins10)

                  // Notify player
                  let totalValue = (totalCoins100 * 100) + (totalCoins10 * 10)
                  player.tell(Component.gold("★ ").append(Component.yellow("Pending Rewards Claimed")).append(Component.gold(" ★")))
                  player.tell(
                    Component.gray("  Claimed ")
                      .append(Component.green(count.toString()))
                      .append(Component.gray(" pending vote reward" + (count !== 1 ? "s" : "") + "!"))
                  )

                  let rewardMsg = Component.gray("  You received: ")
                  if (totalCoins100 > 0) {
                    rewardMsg.append(Component.blue(totalCoins100 + "x "))
                      .append(Component.gold("$100 Coin"))
                  }
                  if (totalCoins100 > 0 && totalCoins10 > 0) {
                    rewardMsg.append(Component.gray(" + "))
                  }
                  if (totalCoins10 > 0) {
                    rewardMsg.append(Component.green(totalCoins10 + "x "))
                      .append(Component.darkGreen("$10 Coin"))
                  }
                  player.tell(rewardMsg)
                  player.tell(
                    Component.gray("  Total: ")
                      .append(Component.green("$" + totalValue))
                  )

                  // Show streak info if multiplier is active
                  if (streakInfo.name) {
                    player.tell(
                      Component.gray("  Streak bonus: ")
                        .append(Component.aqua(streakInfo.name))
                        .append(Component.gray(" (x" + streakInfo.multiplier + ")"))
                    )
                  }

                  console.info("[KubeVote] " + playerName + " claimed " + count + " pending rewards ($" + totalValue + ") (streak: " + data.streak.count + " day" + (data.streak.count !== 1 ? "s" : "") + ", x" + streakInfo.multiplier + ")")
                  ctx.getSource().sendSystemMessage(Component.green("Gave " + count + " pending rewards to " + playerName))

                  return 1
                })
            )
        )
      )

      // /kubevote process <player> <service> - Process incoming vote
      .then(Commands.literal("process")
        .then(
          Commands.argument("player", Arguments.STRING.create(event))
            .then(
              Commands.argument("service", Arguments.STRING.create(event))
                .executes(ctx => {
                  let playerName = Arguments.STRING.getResult(ctx, "player")
                  let serviceId = Arguments.STRING.getResult(ctx, "service")
                  let server = ctx.getSource().getServer()

                  let result = processVote(server, playerName, serviceId)

                  if (result.success) {
                    let coinDisplay = formatCoinReward(result.coins100, result.coins10)
                    ctx.getSource().sendSystemMessage(
                      Component.green("Vote processed for " + playerName + " from " + serviceId + " - reward: " + coinDisplay + " ($" + result.value + ")")
                    )
                  } else {
                    ctx.getSource().sendSystemMessage(
                      Component.yellow("Vote not processed for " + playerName + ": " + result.message)
                    )
                  }

                  return result.success ? 1 : 0
                })
            )
        )
      )

      // /kubevote admin - Admin subcommands
      .then(Commands.literal("admin")
        .executes(ctx => {
          ctx.getSource().sendSystemMessage(Component.gold("=== KubeVote Admin Commands ==="))
          ctx.getSource().sendSystemMessage(Component.yellow("/kubevote admin reset <player>").append(Component.gray(" - Reset player vote data")))
          ctx.getSource().sendSystemMessage(Component.yellow("/kubevote admin reload").append(Component.gray(" - Reload vote data")))
          return 1
        })

        // /kubevote admin reset <player>
        .then(Commands.literal("reset")
          .then(
            Commands.argument("player", Arguments.GAME_PROFILE.create(event))
              .executes(ctx => {
                let profiles = Arguments.GAME_PROFILE.getResult(ctx, "player")
                let profileArray = profiles.toArray()

                if (profileArray.length === 0) {
                  ctx.getSource().sendFailure(Component.red("Player not found"))
                  return 0
                }

                let server = ctx.getSource().getServer()
                let profile = profileArray[0]
                let uuid = profile.getId().toString()
                let playerName = profile.getName()

                ensureDataLoaded(server)

                // Reset player data from cache
                delete voteDataCache[uuid]
                delete leaderboardCache.votes[uuid]

                // Remove from database
                deletePlayerVoteData(server, uuid)

                ctx.getSource().sendSystemMessage(
                  Component.green("Reset vote data for " + playerName)
                )

                return 1
              })
          )
        )

        // /kubevote admin reload
        .then(Commands.literal("reload")
          .executes(ctx => {
            let server = ctx.getSource().getServer()
            dataLoaded = false
            ensureDataLoaded(server)
            ctx.getSource().sendSystemMessage(Component.green("Vote data reloaded"))
            return 1
          })
        )
      )
  )

  // Helper function to show vote stats
  function showVoteStats(src, uuid, playerName) {
    let server = src.getServer()
    ensureDataLoaded(server)

    let data = voteDataCache[uuid]
    if (!data) {
      src.sendSystemMessage(Component.gray("No vote data found for " + playerName))
      return 1
    }

    src.sendSystemMessage(Component.gold("========== Vote Stats: " + playerName + " =========="))

    // Total votes
    src.sendSystemMessage(
      Component.empty()
        .append(Component.gray("Total Votes: "))
        .append(Component.yellow(data.totalVotes.toString()))
    )

    // Streak
    let streakInfo = getStreakMultiplier(data.streak.count)
    src.sendSystemMessage(
      Component.empty()
        .append(Component.gray("Current Streak: "))
        .append(Component.yellow(data.streak.count + " day" + (data.streak.count !== 1 ? "s" : "")))
        .append(streakInfo.name ? Component.aqua(" (" + streakInfo.name + ")") : Component.empty())
    )

    // Multiplier
    src.sendSystemMessage(
      Component.empty()
        .append(Component.gray("Reward Multiplier: "))
        .append(Component.green("x" + streakInfo.multiplier))
    )

    // Monthly votes
    let monthlyVotes = leaderboardCache.votes[uuid] || 0
    src.sendSystemMessage(
      Component.empty()
        .append(Component.gray("This Month: "))
        .append(Component.yellow(monthlyVotes + " vote" + (monthlyVotes !== 1 ? "s" : "")))
    )

    // Per-site cooldowns
    let now = Date.now()
    src.sendSystemMessage(Component.gray("--- Site Cooldowns ---"))
    for (let i = 0; i < VOTING_SITES.length; i++) {
      let site = VOTING_SITES[i]
      if (site.hidden) continue
      let lastVote = data.lastVotes[site.id] || 0
      let timeUntilReady = site.cooldown - (now - lastVote)

      let siteMsg = Component.empty()
        .append(Component.gray(site.name + ": "))

      if (timeUntilReady <= 0) {
        siteMsg.append(Component.green("Ready"))
      } else {
        siteMsg.append(Component.red(formatTimeRemaining(timeUntilReady)))
      }

      src.sendSystemMessage(siteMsg)
    }

    return 1
  }
})

console.info("[KubeVote] Vote command system loaded")

})()
