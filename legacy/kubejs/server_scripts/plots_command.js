// Plots - standalone plot system on top of the Wallet mod.
//
// Split out of kubeshop.js when the wallet/shop economy moved into the Wallet
// mod. This script keeps ONLY plots: named one-chunk claims sold near spawn.
// It grafts "/wallet plot" and "/wallet admin plot" onto the mod's /wallet
// command (Brigadier merges same-name roots), owns the kubeshop_plots table,
// and pays through the mod's wallet_balances / wallet_history tables.
//
// DEPLOY: together with the Wallet mod, replacing kubeshop.js. Never run this
// alongside kubeshop.js - both would register /wallet plot.

;(function () {

// ============================================================================
// DATABASE (same kubejs/config/kubeshop.json the old script used)
// ============================================================================

let dbConfig = {}
try {
  dbConfig = JsonIO.read('kubejs/config/kubeshop.json') || {}
} catch (e) {
  console.warn('[Plots] Could not load config file, using defaults: ' + e)
}

const DB_HOST = dbConfig.host || 'localhost'
const DB_PORT = parseInt(dbConfig.port || '3306')
const DB_NAME = dbConfig.database || 'minecraft'
const DB_USER = dbConfig.user || 'root'
const DB_PASS = dbConfig.password || ''
const MAX_HISTORY_PER_PLAYER = 50

let SqlTypes = Java.loadClass('java.sql.Types')
let MysqlDriver = Java.loadClass('com.mysql.cj.jdbc.Driver')
let mysqlDriver = new MysqlDriver()

function getConnection() {
  let url = 'jdbc:mysql://' + DB_HOST + ':' + DB_PORT + '/' + DB_NAME +
    '?user=' + encodeURIComponent(DB_USER) +
    '&password=' + encodeURIComponent(DB_PASS) +
    '&autoReconnect=true'
  return mysqlDriver.connect(url, null)
}

function closeQuietly(resource) {
  if (resource) {
    try { resource.close() } catch(e) {}
  }
}

let databaseAvailable = false

function initDatabase() {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.createStatement()
    stmt.executeUpdate(
      'CREATE TABLE IF NOT EXISTS kubeshop_plots (' +
      '  plot_key VARCHAR(160) PRIMARY KEY,' +
      '  dimension VARCHAR(96) NOT NULL,' +
      '  chunk_x INT NOT NULL,' +
      '  chunk_z INT NOT NULL,' +
      '  price INT NOT NULL,' +
      '  owner_uuid VARCHAR(36) NULL,' +
      '  sale_price INT NULL,' +
      '  name VARCHAR(64) NULL,' +
      '  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
      ')'
    )
    try { stmt.executeUpdate('ALTER TABLE kubeshop_plots ADD COLUMN sale_price INT NULL') } catch(e) {}
    try { stmt.executeUpdate('ALTER TABLE kubeshop_plots ADD COLUMN name VARCHAR(64) NULL') } catch(e) {}
    try {
      stmt.executeUpdate('SET @plot_no := 0')
      stmt.executeUpdate(
        "UPDATE kubeshop_plots SET name = CONCAT('Plot ', @plot_no := @plot_no + 1) " +
        'WHERE name IS NULL ORDER BY created_at'
      )
    } catch(e) {
      console.warn('[Plots] could not name existing plots: ' + e)
    }
    databaseAvailable = true
    console.info('[Plots] Database ready')
  } catch(e) {
    databaseAvailable = false
    console.error('[Plots] FAILED TO CONNECT TO DATABASE: ' + e)
    console.error('[Plots] Plot features will be DISABLED')
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

initDatabase()

// ============================================================================
// WALLET ACCESS - the Wallet mod's tables. Same coupling archive_event.js has:
// the schema is the API. If the mod ever changes it, this script follows.
// ============================================================================

function getBalance(server, uuid) {
  let conn = null
  let stmt = null
  let rs = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('SELECT balance FROM wallet_balances WHERE uuid = ?')
    stmt.setString(1, uuid)
    rs = stmt.executeQuery()
    if (rs.next()) return rs.getInt('balance')
    return 0
  } catch(e) {
    console.error('[Plots] getBalance error: ' + e)
    return 0
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function addBalance(server, uuid, amount) {
  if (amount < 0) return false
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement(
      'INSERT INTO wallet_balances (uuid, balance) VALUES (?, ?) ' +
      'ON DUPLICATE KEY UPDATE balance = balance + ?'
    )
    stmt.setString(1, uuid)
    stmt.setInt(2, Math.floor(amount))
    stmt.setInt(3, Math.floor(amount))
    stmt.executeUpdate()
    return true
  } catch(e) {
    console.error('[Plots] addBalance error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function removeBalance(server, uuid, amount) {
  if (amount < 0) return false
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('UPDATE wallet_balances SET balance = balance - ? WHERE uuid = ? AND balance >= ?')
    stmt.setInt(1, Math.floor(amount))
    stmt.setString(2, uuid)
    stmt.setInt(3, Math.floor(amount))
    return stmt.executeUpdate() > 0
  } catch(e) {
    console.error('[Plots] removeBalance error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function addHistoryEntry(server, playerUuid, type, amount, otherPlayer, description) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement(
      'INSERT INTO wallet_history (player_uuid, type, amount, other_player, description) VALUES (?, ?, ?, ?, ?)'
    )
    stmt.setString(1, playerUuid)
    stmt.setString(2, type)
    stmt.setInt(3, amount)
    if (otherPlayer) stmt.setString(4, otherPlayer)
    else stmt.setNull(4, SqlTypes.VARCHAR)
    if (description) stmt.setString(5, description)
    else stmt.setNull(5, SqlTypes.VARCHAR)
    stmt.executeUpdate()
    closeQuietly(stmt)
    stmt = conn.prepareStatement(
      'DELETE FROM wallet_history WHERE player_uuid = ? AND id NOT IN (' +
      '  SELECT id FROM (SELECT id FROM wallet_history WHERE player_uuid = ? ORDER BY created_at DESC LIMIT ?) AS t' +
      ')'
    )
    stmt.setString(1, playerUuid)
    stmt.setString(2, playerUuid)
    stmt.setInt(3, MAX_HISTORY_PER_PLAYER)
    stmt.executeUpdate()
  } catch(e) {
    console.error('[Plots] addHistoryEntry error: ' + e)
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function getPlayerNameByUuid(server, uuid) {
  let online = server.getPlayer(uuid)
  if (online) return online.getName().getString()
  try {
    let cache = server.getProfileCache()
    if (cache) {
      let prof = cache.get(Java.loadClass('java.util.UUID').fromString(uuid))
      if (prof && prof.isPresent()) return prof.get().getName()
    }
  } catch(e) {}
  return uuid.substring(0, 8) + '...'
}

function formatBalance(amount) {
  return '$' + amount
}

// ============================================================================
// PLOT DATA (kubeshop_plots - this script's own table, name kept for the data)
// ============================================================================

function getPlayerPlot(player) {
  let dim = String(player.getLevel().getDimension())
  return {
    dim: dim,
    cx: Math.floor(player.getX() / 16),
    cz: Math.floor(player.getZ() / 16),
    key: dim + '_' + Math.floor(player.getX() / 16) + '_' + Math.floor(player.getZ() / 16)
  }
}

function dimIdOf(dimString) {
  let m = String(dimString).match(/([a-z0-9_.-]+:[a-z0-9_.\/-]+)\s*\]?$/)
  return m ? m[1] : 'minecraft:overworld'
}

function readPlotRow(rs) {
  let salePrice = rs.getInt('sale_price')
  if (rs.wasNull()) salePrice = null
  return {
    key: rs.getString('plot_key'),
    dim: rs.getString('dimension'),
    cx: rs.getInt('chunk_x'),
    cz: rs.getInt('chunk_z'),
    price: rs.getInt('price'),
    owner: rs.getString('owner_uuid'),
    salePrice: salePrice,
    name: rs.getString('name')
  }
}

function plotLabel(plot) {
  return plot.name ? plot.name : 'Unnamed plot'
}

function nextPlotName() {
  let conn = null
  let stmt = null
  let rs = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement(
      "SELECT MAX(CAST(SUBSTRING(name, 6) AS UNSIGNED)) AS n FROM kubeshop_plots WHERE name REGEXP '^Plot [0-9]+$'"
    )
    rs = stmt.executeQuery()
    let highest = 0
    if (rs.next()) highest = rs.getInt('n')
    return 'Plot ' + (highest + 1)
  } catch(e) {
    console.error('[Plots] nextPlotName error: ' + e)
    return 'Plot'
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function getPlot(plotKey) {
  let conn = null
  let stmt = null
  let rs = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('SELECT * FROM kubeshop_plots WHERE plot_key = ?')
    stmt.setString(1, plotKey)
    rs = stmt.executeQuery()
    if (rs.next()) return readPlotRow(rs)
    return null
  } catch(e) {
    console.error('[Plots] getPlot error: ' + e)
    return null
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function savePlot(plot, price, name) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement(
      'INSERT INTO kubeshop_plots (plot_key, dimension, chunk_x, chunk_z, price, name) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE price = ?, name = ?'
    )
    stmt.setString(1, plot.key)
    stmt.setString(2, plot.dim)
    stmt.setInt(3, plot.cx)
    stmt.setInt(4, plot.cz)
    stmt.setInt(5, price)
    stmt.setString(6, name)
    stmt.setInt(7, price)
    stmt.setString(8, name)
    stmt.executeUpdate()
    return true
  } catch(e) {
    console.error('[Plots] savePlot error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function deletePlot(plotKey) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('DELETE FROM kubeshop_plots WHERE plot_key = ?')
    stmt.setString(1, plotKey)
    return stmt.executeUpdate() > 0
  } catch(e) {
    console.error('[Plots] deletePlot error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

// Take ownership only while the plot is still unsold, so two buyers clicking at
// the same moment cannot both get it.
function takePlot(plotKey, uuid) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('UPDATE kubeshop_plots SET owner_uuid = ? WHERE plot_key = ? AND owner_uuid IS NULL')
    stmt.setString(1, uuid)
    stmt.setString(2, plotKey)
    return stmt.executeUpdate() > 0
  } catch(e) {
    console.error('[Plots] takePlot error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function setPlotSalePrice(plotKey, ownerUuid, price) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('UPDATE kubeshop_plots SET sale_price = ? WHERE plot_key = ? AND owner_uuid = ?')
    if (price === null) stmt.setNull(1, SqlTypes.INTEGER)
    else stmt.setInt(1, price)
    stmt.setString(2, plotKey)
    stmt.setString(3, ownerUuid)
    return stmt.executeUpdate() > 0
  } catch(e) {
    console.error('[Plots] setPlotSalePrice error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

// Guarded on seller AND asking price, so a plot relisted or sold a moment
// earlier cannot be bought at the stale price.
function transferPlot(plotKey, sellerUuid, buyerUuid, price) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement(
      'UPDATE kubeshop_plots SET owner_uuid = ?, sale_price = NULL ' +
      'WHERE plot_key = ? AND owner_uuid = ? AND sale_price = ?'
    )
    stmt.setString(1, buyerUuid)
    stmt.setString(2, plotKey)
    stmt.setString(3, sellerUuid)
    stmt.setInt(4, price)
    return stmt.executeUpdate() > 0
  } catch(e) {
    console.error('[Plots] transferPlot error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function restoreListing(plotKey, sellerUuid, price) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('UPDATE kubeshop_plots SET owner_uuid = ?, sale_price = ? WHERE plot_key = ?')
    stmt.setString(1, sellerUuid)
    stmt.setInt(2, price)
    stmt.setString(3, plotKey)
    stmt.executeUpdate()
  } catch(e) {
    console.error('[Plots] restoreListing error: ' + e)
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function releasePlot(plotKey) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('UPDATE kubeshop_plots SET owner_uuid = NULL, sale_price = NULL WHERE plot_key = ?')
    stmt.setString(1, plotKey)
    stmt.executeUpdate()
  } catch(e) {
    console.error('[Plots] releasePlot error: ' + e)
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function getAllPlots() {
  let conn = null
  let stmt = null
  let rs = null
  let plots = []
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('SELECT * FROM kubeshop_plots ORDER BY dimension, chunk_x, chunk_z')
    rs = stmt.executeQuery()
    while (rs.next()) plots.push(readPlotRow(rs))
    return plots
  } catch(e) {
    console.error('[Plots] getAllPlots error: ' + e)
    return []
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function validPlotName(source, name) {
  name = String(name).trim()
  if (!name) {
    source.sendFailure(Component.red('Give the plot a name'))
    return null
  }
  if (name.length > 64) {
    source.sendFailure(Component.red('Plot names are 64 characters at most'))
    return null
  }
  return name
}

// ============================================================================
// CLAIMS - Open Parties and Claims (DeceasedCraft). Claims are held by UUID,
// so offline owners work.
// ============================================================================

const CLAIM_OFFLINE = true

let OpenPACServerAPI = null
let ResourceLocationClass = null
let serverClaimUuid = null
let opacAvailable = false
try {
  OpenPACServerAPI = Java.loadClass('xaero.pac.common.server.api.OpenPACServerAPI')
  ResourceLocationClass = Java.loadClass('net.minecraft.resources.ResourceLocation')
  opacAvailable = true
  console.info('[Plots] Open Parties and Claims API loaded')
} catch(e) {
  console.info('[Plots] OPAC API not available - plots will not be auto-claimed: ' + e)
}

// Recent OPAC publishes it as SpecialClaimOwners.SERVER; 0.25.8, the build
// DeceasedCraft ships, only has it on the internal config class.
if (opacAvailable) {
  try {
    serverClaimUuid = Java.loadClass('xaero.pac.common.claims.api.SpecialClaimOwners').SERVER
  } catch(e) {
    try {
      serverClaimUuid = Java.loadClass('xaero.pac.common.server.player.config.PlayerConfig').SERVER_CLAIM_UUID
    } catch(e2) {
      console.warn('[Plots] OPAC server-claim UUID not found: ' + e2)
    }
  }
}

function getClaimsManager(server) {
  if (!opacAvailable) return null
  try {
    let api = OpenPACServerAPI.get(server)
    try { return api.getServerClaimsManager() } catch(e) { return api.serverClaimsManager }
  } catch(e) {
    console.warn('[Plots] OPAC claims manager unavailable: ' + e)
    return null
  }
}

function claimOwnerId(claim) {
  try { return claim.getPlayerId() } catch(e) { return claim.playerId }
}

function javaUuid(uuidStr) {
  return Java.loadClass('java.util.UUID').fromString(String(uuidStr))
}

// { claimed, mine, server, otherMember, who }
function getChunkClaimState(player, otherUuidStr) {
  let state = { claimed: false, mine: false, server: false, otherMember: false, who: null }
  let manager = getClaimsManager(player.getServer())
  if (!manager) return state
  try {
    let pos = getPlayerPlot(player)
    let claim = manager.get(new ResourceLocationClass(dimIdOf(pos.dim)), pos.cx, pos.cz)
    if (!claim) return state
    let ownerId = claimOwnerId(claim)
    state.claimed = true
    state.server = serverClaimUuid !== null && ownerId.equals(serverClaimUuid)
    state.mine = ownerId.equals(javaUuid(player.getStringUuid()))
    state.who = state.server ? 'the server' : getPlayerNameByUuid(player.getServer(), String(ownerId))
    if (otherUuidStr) state.otherMember = ownerId.equals(javaUuid(otherUuidStr))
  } catch(e) {
    console.error('[Plots] getChunkClaimState error: ' + e)
  }
  return state
}

function unclaimChunkAt(player, source) {
  let manager = getClaimsManager(player.getServer())
  if (!manager) return { ok: false, msg: 'Open Parties and Claims is not available' }
  try {
    let pos = getPlayerPlot(player)
    manager.unclaim(new ResourceLocationClass(dimIdOf(pos.dim)), pos.cx, pos.cz)
    return { ok: true, msg: null }
  } catch(e) {
    console.error('[Plots] unclaim failed: ' + e)
    return { ok: false, msg: String(e) }
  }
}

// Claim the chunk `player` stands in for ownerUuidStr, releasing an existing
// claim first. This API skips OPAC's own limit and permission checks, which is
// the point for a plot that was paid for. ownerOnline is unused (UUID claims).
function claimChunkFor(player, source, ownerUuidStr, ownerOnline) {
  let manager = getClaimsManager(player.getServer())
  if (!manager) return { ok: false, msg: 'Open Parties and Claims is not available' }
  try {
    let pos = getPlayerPlot(player)
    let dim = new ResourceLocationClass(dimIdOf(pos.dim))
    let owner = javaUuid(ownerUuidStr)
    let existing = manager.get(dim, pos.cx, pos.cz)
    if (existing && claimOwnerId(existing).equals(owner)) return { ok: true, msg: null }
    if (existing) manager.unclaim(dim, pos.cx, pos.cz)
    let claim = manager.claim(dim, owner, -1, pos.cx, pos.cz, false)
    if (claim) return { ok: true, msg: null }
    return { ok: false, msg: 'claims are disabled in this dimension' }
  } catch(e) {
    console.error('[Plots] auto-claim failed: ' + e)
    return { ok: false, msg: String(e) }
  }
}

// ============================================================================
// COMMANDS - grafted onto the Wallet mod's /wallet tree (Brigadier merges
// same-name literals across registrations)
// ============================================================================

function adminAddPlot(ctx, price, explicitName) {
  let player = ctx.getSource().getPlayer()
  if (player == null) {
    ctx.getSource().sendFailure(Component.red('This command can only be used by players'))
    return 0
  }
  if (price < 0) {
    ctx.getSource().sendFailure(Component.red('Price cannot be negative'))
    return 0
  }
  if (explicitName) {
    explicitName = validPlotName(ctx.getSource(), explicitName)
    if (!explicitName) return 0
  }

  let pos = getPlayerPlot(player)
  let existing = getPlot(pos.key)
  let name = explicitName || (existing && existing.name ? existing.name : nextPlotName())

  if (!savePlot(pos, price, name)) {
    ctx.getSource().sendFailure(Component.red('Could not save the plot, check the server log'))
    return 0
  }

  ctx.getSource().sendSystemMessage(
    Component.empty()
      .append(Component.gold(existing ? 'Updated ' : 'Put '))
      .append(Component.white(name))
      .append(Component.gold(existing ? ' to ' : ' up for sale at '))
      .append(Component.green(formatBalance(price)))
      .append(Component.gray(' (chunk ' + pos.cx + ', ' + pos.cz + ' in ' + dimIdOf(pos.dim) + ')'))
  )
  if (existing && existing.owner) {
    ctx.getSource().sendSystemMessage(
      Component.yellow('Note: this plot is already owned by ')
        .append(Component.aqua(getPlayerNameByUuid(ctx.getSource().getServer(), existing.owner)))
    )
  }
  return 1
}

ServerEvents.commandRegistry(event => {
  let Commands = event.getCommands()
  let Arguments = event.getArguments()

  event.register(
    Commands.literal('wallet')
      .then(Commands.literal('plot')
        .requires(src => databaseAvailable)
        .executes(ctx => {
          let player = ctx.getSource().getPlayer()
          if (player == null) {
            ctx.getSource().sendFailure(Component.red('This command can only be used by players'))
            return 0
          }
          let pos = getPlayerPlot(player)
          let plot = getPlot(pos.key)
          if (!plot) {
            player.sendSystemMessage(Component.red('You are not standing on a plot'))
            player.sendSystemMessage(Component.gray('See ').append(Component.yellow('/wallet plot list')).append(Component.gray(' for plots you can buy')))
            return 1
          }
          let label = plotLabel(plot)
          if (plot.owner && plot.salePrice === null) {
            let ownerName = plot.owner === player.getStringUuid()
              ? 'you'
              : getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)
            player.sendSystemMessage(
              Component.empty().append(Component.gold(label + ' is owned by ')).append(Component.aqua(ownerName))
            )
            if (plot.owner === player.getStringUuid()) {
              player.sendSystemMessage(Component.gray('Sell it with ').append(Component.yellow('/wallet plot sell <price>')))
            }
            return 1
          }
          if (plot.owner === player.getStringUuid()) {
            player.sendSystemMessage(
              Component.empty()
                .append(Component.gold(label + ' is yours, listed for '))
                .append(Component.green(formatBalance(plot.salePrice)))
            )
            player.sendSystemMessage(Component.gray('Take it off the market with ').append(Component.yellow('/wallet plot unsell')))
            return 1
          }
          let price = plot.owner ? plot.salePrice : plot.price
          let msg = Component.empty().append(Component.gold(label + ' is for sale for '))
            .append(Component.green(formatBalance(price)))
          if (plot.owner) {
            msg.append(Component.gold(' by ')).append(Component.aqua(getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)))
          }
          player.sendSystemMessage(msg)
          player.sendSystemMessage(
            Component.green('[BUY]')
              .clickRunCommand('/wallet plot buy')
              .hover(Component.gray('Buy ' + label + ' for ' + formatBalance(price)))
          )
          return 1
        })

        .then(Commands.literal('buy')
          .executes(ctx => {
            let player = ctx.getSource().getPlayer()
            if (player == null) {
              ctx.getSource().sendFailure(Component.red('This command can only be used by players'))
              return 0
            }
            let srv = ctx.getSource().getServer()
            let pUuid = player.getStringUuid()
            let pos = getPlayerPlot(player)
            let plot = getPlot(pos.key)
            if (!plot) {
              ctx.getSource().sendFailure(Component.red('You are not standing on a plot'))
              return 0
            }
            let label = plotLabel(plot)
            if (plot.owner === pUuid) {
              ctx.getSource().sendFailure(Component.red('You already own ' + label))
              return 0
            }
            if (plot.owner && plot.salePrice === null) {
              ctx.getSource().sendFailure(
                Component.empty()
                  .append(Component.red(label + ' is already owned by '))
                  .append(Component.yellow(getPlayerNameByUuid(srv, plot.owner)))
              )
              return 0
            }

            let seller = plot.owner
            let sellerName = seller ? getPlayerNameByUuid(srv, seller) : null
            let price = seller ? plot.salePrice : plot.price

            // Refuse before taking money if a claim that is not part of this
            // sale holds the chunk.
            let claimState = getChunkClaimState(player, seller)
            if (claimState.claimed && !claimState.mine && !claimState.server && !claimState.otherMember) {
              ctx.getSource().sendFailure(
                Component.empty()
                  .append(Component.red(label + ' is claimed by '))
                  .append(Component.yellow(claimState.who))
                  .append(Component.red(' - tell an admin'))
              )
              return 0
            }

            let balance = getBalance(srv, pUuid)
            if (balance < price) {
              ctx.getSource().sendFailure(
                Component.empty()
                  .append(Component.red('You need '))
                  .append(Component.yellow(formatBalance(price)))
                  .append(Component.red(' but only have '))
                  .append(Component.yellow(formatBalance(balance)))
              )
              return 0
            }

            let taken = seller
              ? transferPlot(pos.key, seller, pUuid, price)
              : takePlot(pos.key, pUuid)
            if (!taken) {
              ctx.getSource().sendFailure(Component.red('Somebody just bought ' + label))
              return 0
            }

            if (!removeBalance(srv, pUuid, price)) {
              if (seller) restoreListing(pos.key, seller, price)
              else releasePlot(pos.key)
              ctx.getSource().sendFailure(Component.red('Could not take the money from your wallet, purchase cancelled'))
              return 0
            }

            addHistoryEntry(srv, pUuid, 'plot_buy', price, sellerName, label)

            if (seller) {
              addBalance(srv, seller, price)
              addHistoryEntry(srv, seller, 'plot_sell', price, player.getName().getString(), label)
              let sellerPlayer = srv.getPlayer(seller)
              if (sellerPlayer) {
                sellerPlayer.sendSystemMessage(
                  Component.empty()
                    .append(Component.yellow(player.getName().getString()))
                    .append(Component.gold(' bought your '))
                    .append(Component.white(label))
                    .append(Component.gold(' for '))
                    .append(Component.green(formatBalance(price)))
                )
              }
            }

            player.sendSystemMessage(
              Component.empty()
                .append(Component.gold('Bought '))
                .append(Component.white(label))
                .append(sellerName ? Component.gold(' from ') : Component.empty())
                .append(sellerName ? Component.aqua(sellerName) : Component.empty())
                .append(Component.gold(' for '))
                .append(Component.green(formatBalance(price)))
                .append(Component.gold(' | Balance: '))
                .append(Component.green(formatBalance(getBalance(srv, pUuid))))
            )

            let claimed = claimChunkFor(player, ctx.getSource(), pUuid, player)
            if (claimed.ok) {
              player.sendSystemMessage(Component.gray('The plot is now claimed for you'))
            } else {
              player.sendSystemMessage(
                Component.yellow('Could not claim it for you (' + claimed.msg + ') - open the map (M) and claim this plot yourself')
              )
            }
            return 1
          })
        )

        .then(Commands.literal('sell')
          .then(
            Commands.argument('price', Arguments.INTEGER.create(event))
              .executes(ctx => {
                let player = ctx.getSource().getPlayer()
                if (player == null) {
                  ctx.getSource().sendFailure(Component.red('This command can only be used by players'))
                  return 0
                }
                let price = Arguments.INTEGER.getResult(ctx, 'price')
                if (price < 0) {
                  ctx.getSource().sendFailure(Component.red('Price cannot be negative'))
                  return 0
                }
                let pos = getPlayerPlot(player)
                let plot = getPlot(pos.key)
                if (!plot || plot.owner !== player.getStringUuid()) {
                  ctx.getSource().sendFailure(Component.red('You do not own the plot you are standing on'))
                  return 0
                }
                if (!setPlotSalePrice(pos.key, player.getStringUuid(), price)) {
                  ctx.getSource().sendFailure(Component.red('Could not list the plot, try again'))
                  return 0
                }
                player.sendSystemMessage(
                  Component.empty()
                    .append(Component.gold('Listed '))
                    .append(Component.white(plotLabel(plot)))
                    .append(Component.gold(' for '))
                    .append(Component.green(formatBalance(price)))
                    .append(Component.gray(' - anyone standing on it can buy it now'))
                )
                return 1
              })
          )
        )

        .then(Commands.literal('unsell')
          .executes(ctx => {
            let player = ctx.getSource().getPlayer()
            if (player == null) {
              ctx.getSource().sendFailure(Component.red('This command can only be used by players'))
              return 0
            }
            let pos = getPlayerPlot(player)
            let plot = getPlot(pos.key)
            if (!plot || plot.owner !== player.getStringUuid()) {
              ctx.getSource().sendFailure(Component.red('You do not own the plot you are standing on'))
              return 0
            }
            if (plot.salePrice === null) {
              ctx.getSource().sendFailure(Component.red(plotLabel(plot) + ' is not listed for sale'))
              return 0
            }
            setPlotSalePrice(pos.key, player.getStringUuid(), null)
            player.sendSystemMessage(
              Component.gold('Took ').append(Component.white(plotLabel(plot))).append(Component.gold(' off the market'))
            )
            return 1
          })
        )

        .then(Commands.literal('list')
          .executes(ctx => {
            let plots = getAllPlots()
            ctx.getSource().sendSystemMessage(Component.gold('=== Plots For Sale ==='))
            let count = 0
            for (let i = 0; i < plots.length; i++) {
              let plot = plots[i]
              if (plot.owner && plot.salePrice === null) continue
              count++
              let row = Component.empty()
                .append(Component.white(plotLabel(plot)))
                .append(Component.gray(' - '))
                .append(Component.green(formatBalance(plot.owner ? plot.salePrice : plot.price)))
              if (plot.owner) {
                row.append(Component.gray(' by '))
                  .append(Component.aqua(getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)))
              }
              ctx.getSource().sendSystemMessage(row)
            }
            if (count === 0) {
              ctx.getSource().sendSystemMessage(Component.gray('No plots for sale right now'))
            } else {
              ctx.getSource().sendSystemMessage(
                Component.gray('Total: ' + count + ' - stand on one and run ')
                  .append(Component.yellow('/wallet plot buy'))
              )
            }
            return 1
          })
        )
      )

      .then(Commands.literal('admin')
        .requires(src => src.hasPermission(2))
        .then(Commands.literal('plot')
          .then(Commands.literal('add')
            .then(
              Commands.argument('price', Arguments.INTEGER.create(event))
                .executes(ctx => adminAddPlot(ctx, Arguments.INTEGER.getResult(ctx, 'price'), null))
                .then(
                  Commands.argument('name', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => adminAddPlot(
                      ctx,
                      Arguments.INTEGER.getResult(ctx, 'price'),
                      Arguments.GREEDY_STRING.getResult(ctx, 'name')
                    ))
                )
            )
          )
          .then(Commands.literal('rename')
            .then(
              Commands.argument('name', Arguments.GREEDY_STRING.create(event))
                .executes(ctx => {
                  let player = ctx.getSource().getPlayer()
                  if (player == null) {
                    ctx.getSource().sendFailure(Component.red('This command can only be used by players'))
                    return 0
                  }
                  let pos = getPlayerPlot(player)
                  let plot = getPlot(pos.key)
                  if (!plot) {
                    ctx.getSource().sendFailure(Component.red('You are not standing on a plot'))
                    return 0
                  }
                  let name = validPlotName(ctx.getSource(), Arguments.GREEDY_STRING.getResult(ctx, 'name'))
                  if (!name) return 0
                  if (!savePlot(pos, plot.price, name)) {
                    ctx.getSource().sendFailure(Component.red('Could not rename the plot, check the server log'))
                    return 0
                  }
                  ctx.getSource().sendSystemMessage(
                    Component.empty()
                      .append(Component.white(plotLabel(plot)))
                      .append(Component.gold(' renamed to '))
                      .append(Component.white(name))
                  )
                  return 1
                })
            )
          )
          .then(Commands.literal('claim_as')
            .then(
              Commands.argument('player', Arguments.GAME_PROFILE.create(event))
                .executes(ctx => {
                  let admin = ctx.getSource().getPlayer()
                  if (admin == null) {
                    ctx.getSource().sendFailure(Component.red('This command can only be used by players'))
                    return 0
                  }
                  let profileArray = Arguments.GAME_PROFILE.getResult(ctx, 'player').toArray()
                  if (profileArray.length === 0) {
                    ctx.getSource().sendFailure(Component.red('No player found'))
                    return 0
                  }
                  let srv = ctx.getSource().getServer()
                  let prof = profileArray[0]
                  let targetUuid = prof.getId().toString()
                  let targetName = prof.getName()
                  let pos = getPlayerPlot(admin)
                  let plot = getPlot(pos.key)
                  if (!plot) {
                    ctx.getSource().sendFailure(Component.red('You are not standing on a plot'))
                    return 0
                  }
                  let label = plotLabel(plot)
                  if (plot.owner === targetUuid) {
                    ctx.getSource().sendFailure(
                      Component.empty().append(Component.yellow(targetName)).append(Component.red(' already owns ' + label))
                    )
                    return 0
                  }
                  if (plot.owner) {
                    ctx.getSource().sendFailure(
                      Component.empty()
                        .append(Component.red(label + ' is owned by '))
                        .append(Component.yellow(getPlayerNameByUuid(srv, plot.owner)))
                        .append(Component.red(' - run '))
                        .append(Component.yellow('/wallet admin plot reclaim'))
                        .append(Component.red(' first'))
                    )
                    return 0
                  }
                  if (!takePlot(pos.key, targetUuid)) {
                    ctx.getSource().sendFailure(Component.red('Somebody just bought ' + label))
                    return 0
                  }
                  addHistoryEntry(srv, targetUuid, 'plot_buy', 0, 'Admin', label)
                  ctx.getSource().sendSystemMessage(
                    Component.empty()
                      .append(Component.gold('Gave '))
                      .append(Component.white(label))
                      .append(Component.gold(' to '))
                      .append(Component.aqua(targetName))
                      .append(Component.gray(' (chunk ' + pos.cx + ', ' + pos.cz + ')'))
                  )

                  let targetPlayer = srv.getPlayer(targetUuid)
                  if (!targetPlayer && !CLAIM_OFFLINE) {
                    ctx.getSource().sendSystemMessage(
                      Component.yellow(targetName + ' is offline - the claim is untouched, run this again once they join')
                    )
                    return 1
                  }
                  let claimed = claimChunkFor(admin, ctx.getSource(), targetUuid, targetPlayer)
                  if (claimed.ok) {
                    ctx.getSource().sendSystemMessage(Component.gray('The plot is now claimed for ' + targetName))
                    if (targetPlayer) {
                      targetPlayer.sendSystemMessage(
                        Component.empty().append(Component.gold('An admin gave you ')).append(Component.white(label))
                      )
                    }
                  } else {
                    ctx.getSource().sendSystemMessage(
                      Component.yellow('Could not claim it for them (' + claimed.msg + ') - they can claim it on the map (M)')
                    )
                  }
                  return 1
                })
            )
          )
          .then(Commands.literal('reclaim')
            .executes(ctx => {
              let player = ctx.getSource().getPlayer()
              if (player == null) {
                ctx.getSource().sendFailure(Component.red('This command can only be used by players'))
                return 0
              }
              let pos = getPlayerPlot(player)
              let plot = getPlot(pos.key)
              if (!plot) {
                ctx.getSource().sendFailure(Component.red('You are not standing on a plot'))
                return 0
              }
              let previousOwner = plot.owner
                ? getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)
                : null
              releasePlot(pos.key)
              let unclaimed = unclaimChunkAt(player, ctx.getSource())
              let msg = Component.empty()
                .append(Component.white(plotLabel(plot)))
                .append(Component.gold(previousOwner ? ' taken back from ' : ' released'))
              if (previousOwner) msg.append(Component.aqua(previousOwner))
              msg.append(Component.gold(' - back on sale for '))
                .append(Component.green(formatBalance(plot.price)))
              ctx.getSource().sendSystemMessage(msg)
              if (!unclaimed.ok) {
                ctx.getSource().sendSystemMessage(
                  Component.yellow('Could not drop the claim (' + unclaimed.msg + ') - unclaim it on the map yourself')
                )
              }
              return 1
            })
          )
          .then(Commands.literal('remove')
            .executes(ctx => {
              let player = ctx.getSource().getPlayer()
              if (player == null) {
                ctx.getSource().sendFailure(Component.red('This command can only be used by players'))
                return 0
              }
              let pos = getPlayerPlot(player)
              let plot = getPlot(pos.key)
              if (!plot) {
                ctx.getSource().sendFailure(Component.red('You are not standing on a plot'))
                return 0
              }
              deletePlot(pos.key)
              let msg = Component.empty()
                .append(Component.gold('Removed '))
                .append(Component.white(plotLabel(plot)))
                .append(Component.gray(' (chunk ' + pos.cx + ', ' + pos.cz + ')'))
              if (plot.owner) {
                msg.append(Component.gray(' (was owned by '))
                  .append(Component.aqua(getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)))
                  .append(Component.gray(', their claim is untouched)'))
              }
              ctx.getSource().sendSystemMessage(msg)
              return 1
            })
          )
          .then(Commands.literal('list')
            .executes(ctx => {
              let srv = ctx.getSource().getServer()
              let plots = getAllPlots()
              ctx.getSource().sendSystemMessage(Component.gold('=== All Plots ==='))
              if (plots.length === 0) {
                ctx.getSource().sendSystemMessage(Component.gray('No plots registered'))
                return 1
              }
              for (let i = 0; i < plots.length; i++) {
                let plot = plots[i]
                let x = plot.cx * 16 + 8
                let z = plot.cz * 16 + 8
                let tpLink = Component.lightPurple('[TP]')
                  .clickRunCommand('/execute in ' + dimIdOf(plot.dim) + ' run tp @s ' + x + ' ~ ' + z)
                  .hover(Component.gray('Click to teleport to ' + x + ', ' + z))
                let status = plot.owner
                  ? Component.aqua(getPlayerNameByUuid(srv, plot.owner))
                  : Component.green('FOR SALE')
                let row = Component.empty()
                  .append(Component.white(plotLabel(plot)))
                  .append(Component.gray(' (' + plot.cx + ', ' + plot.cz + ') - '))
                  .append(Component.green(formatBalance(plot.price)))
                  .append(Component.gray(' - '))
                  .append(status)
                if (plot.salePrice !== null) {
                  row.append(Component.gray(', listed for '))
                    .append(Component.green(formatBalance(plot.salePrice)))
                }
                ctx.getSource().sendSystemMessage(row.append(Component.gray(' ')).append(tpLink))
              }
              ctx.getSource().sendSystemMessage(Component.gray('Total: ' + plots.length + ' plots'))
              return 1
            })
          )
        )
      )
  )
})

console.info('[Plots] Plot system loaded (standalone, Wallet mod economy)')

})()
