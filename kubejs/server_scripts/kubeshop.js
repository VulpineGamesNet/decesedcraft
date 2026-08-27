// KubeShop - economy, coins and sign shops
// Target: Minecraft 1.20.1 / Forge / KubeJS 2001.6.x
//
// Ported from the ATM10 script. Coin items use 1.20.1 NBT rather than 1.21 data
// components, and claim protection is handled by an Open Parties and Claims
// config exception rather than the FTB Chunks bypass API.
//
// Wrapped in an IIFE: all server_scripts/*.js share one global scope.

;(function () {

// KubeShop - Complete Economy & Shop System (MySQL Version)
// Single file to avoid KubeJS scope issues between scripts

// ============================================================================
// MYSQL CONFIGURATION - Read from config file
// ============================================================================

// Load config from kubejs/config/kubeshop.json
let dbConfig = {}
try {
  dbConfig = JsonIO.read('kubejs/config/kubeshop.json') || {}
} catch (e) {
  console.warn('[KubeShop] Could not load config file, using defaults: ' + e)
}

const DB_HOST = dbConfig.host || 'localhost'
const DB_PORT = parseInt(dbConfig.port || '3306')
const DB_NAME = dbConfig.database || 'minecraft'
const DB_USER = dbConfig.user || 'root'
const DB_PASS = dbConfig.password || ''

const STARTING_BALANCE = 0
const MAX_HISTORY_PER_PLAYER = 50

// Server shops trade against this wallet. A real UUID, so the UUID.fromString
// calls on the player-uuid paths it flows through do not throw on it.
const SERVER_UUID = '00000000-0000-0000-0000-000000000000'

// Coin denominations for withdraw/deposit (ordered largest to smallest for greedy algorithm)
const COIN_BASE_ITEM = 'minecraft:gold_nugget'
const COIN_DENOMINATIONS = [
  { value: 10000, customModelData: 710000, name: 'Coin', lore: 'Worth $10,000', color: 'gold' },
  { value: 1000,  customModelData: 719999, name: 'Coin', lore: 'Worth $1,000',  color: 'light_purple' },
  { value: 100,   customModelData: 719100, name: 'Coin', lore: 'Worth $100',    color: 'blue' },
  { value: 10,    customModelData: 719010, name: 'Coin', lore: 'Worth $10',     color: 'green' },
  { value: 1,     customModelData: 719001, name: 'Coin', lore: 'Worth $1',      color: 'white' }
]

// ============================================================================
// MYSQL CONNECTION
// ============================================================================

let SqlTypes = Java.loadClass('java.sql.Types')

// Use MySQL driver directly to bypass DriverManager restrictions
let MysqlDriver = Java.loadClass('com.mysql.cj.jdbc.Driver')
let mysqlDriver = new MysqlDriver()

function getConnection() {
  // Pass credentials in URL to avoid needing java.util.Properties
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

// Track database availability
let databaseAvailable = false

// Initialize database tables on script load
function initDatabase() {
  let conn = null
  let stmt = null
  try {
    console.info('[KubeShop] Connecting to database at ' + DB_HOST + ':' + DB_PORT + '/' + DB_NAME + '...')
    conn = getConnection()
    stmt = conn.createStatement()

    // Create wallets table
    stmt.executeUpdate(
      'CREATE TABLE IF NOT EXISTS kubeshop_wallets (' +
      '  uuid VARCHAR(36) PRIMARY KEY,' +
      '  balance INT NOT NULL DEFAULT 0,' +
      '  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' +
      ')'
    )

    // Create shops table
    stmt.executeUpdate(
      'CREATE TABLE IF NOT EXISTS kubeshop_shops (' +
      '  sign_key VARCHAR(128) PRIMARY KEY,' +
      '  owner_uuid VARCHAR(36) NOT NULL,' +
      '  chest_pos VARCHAR(128) NOT NULL,' +
      '  shop_type VARCHAR(4) NOT NULL,' +
      '  price INT NOT NULL,' +
      '  item_template TEXT NOT NULL,' +
      '  is_server TINYINT(1) NOT NULL DEFAULT 0,' +
      '  is_infinite TINYINT(1) NOT NULL DEFAULT 0,' +
      '  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
      ')'
    )

    // Server and infinite shops arrived after the first shops shipped.
    try {
      stmt.executeUpdate('ALTER TABLE kubeshop_shops ADD COLUMN is_server TINYINT(1) NOT NULL DEFAULT 0')
    } catch(e) {}
    try {
      stmt.executeUpdate('ALTER TABLE kubeshop_shops ADD COLUMN is_infinite TINYINT(1) NOT NULL DEFAULT 0')
    } catch(e) {}

    // Create plots table (purchasable chunks)
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

    // Create history table
    stmt.executeUpdate(
      'CREATE TABLE IF NOT EXISTS kubeshop_history (' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,' +
      '  player_uuid VARCHAR(36) NOT NULL,' +
      '  type VARCHAR(20) NOT NULL,' +
      '  amount INT NOT NULL,' +
      '  other_player VARCHAR(64),' +
      '  description TEXT,' +
      '  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,' +
      '  INDEX idx_player_uuid (player_uuid),' +
      '  INDEX idx_created_at (created_at)' +
      ')'
    )

    databaseAvailable = true
    console.info('[KubeShop] Database tables initialized successfully')
  } catch(e) {
    databaseAvailable = false
    console.error('[KubeShop] ========================================')
    console.error('[KubeShop] FAILED TO CONNECT TO DATABASE!')
    console.error('[KubeShop] Error: ' + e)
    console.error('[KubeShop] Host: ' + DB_HOST + ':' + DB_PORT + '/' + DB_NAME)
    console.error('[KubeShop] User: ' + DB_USER)
    console.error('[KubeShop] KubeShop economy features will be DISABLED')
    console.error('[KubeShop] ========================================')
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

// Initialize database on script load
initDatabase()

// Lightweight cache of shop sign keys for tick handler (avoid DB queries every 2 ticks)
let shopSignKeysCache = {}
let shopSignKeysCacheLastRefresh = 0
const SHOP_CACHE_REFRESH_TICKS = 100  // Refresh every 5 seconds

function refreshShopSignKeysCache() {
  if (!databaseAvailable) return

  let conn = null
  let stmt = null
  let rs = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('SELECT sign_key FROM kubeshop_shops')
    rs = stmt.executeQuery()
    let newCache = {}
    while (rs.next()) {
      newCache[rs.getString('sign_key')] = true
    }
    shopSignKeysCache = newCache
  } catch(e) {
    console.error('[KubeShop] refreshShopSignKeysCache error: ' + e)
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function isShopSignKey(signKey) {
  return shopSignKeysCache[signKey] === true
}

// Pre-populate shop sign keys cache
refreshShopSignKeysCache()

// ============================================================================
// CURRENCY SYSTEM - MySQL Functions
// ============================================================================

function getBalance(server, uuid) {
  let conn = null
  let stmt = null
  let rs = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('SELECT balance FROM kubeshop_wallets WHERE uuid = ?')
    stmt.setString(1, uuid)
    rs = stmt.executeQuery()
    if (rs.next()) {
      return rs.getInt('balance')
    }
    // Player not found, create with starting balance
    closeQuietly(rs)
    closeQuietly(stmt)
    stmt = conn.prepareStatement('INSERT INTO kubeshop_wallets (uuid, balance) VALUES (?, ?)')
    stmt.setString(1, uuid)
    stmt.setInt(2, STARTING_BALANCE)
    stmt.executeUpdate()
    return STARTING_BALANCE
  } catch(e) {
    console.error('[KubeShop] getBalance error: ' + e)
    return STARTING_BALANCE
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function setBalance(server, uuid, amount) {
  if (amount < 0) return false
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement(
      'INSERT INTO kubeshop_wallets (uuid, balance) VALUES (?, ?) ' +
      'ON DUPLICATE KEY UPDATE balance = ?'
    )
    stmt.setString(1, uuid)
    stmt.setInt(2, Math.floor(amount))
    stmt.setInt(3, Math.floor(amount))
    stmt.executeUpdate()
    return true
  } catch(e) {
    console.error('[KubeShop] setBalance error: ' + e)
    return false
  } finally {
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
    // First ensure player exists
    stmt = conn.prepareStatement(
      'INSERT INTO kubeshop_wallets (uuid, balance) VALUES (?, ?) ' +
      'ON DUPLICATE KEY UPDATE balance = balance + ?'
    )
    stmt.setString(1, uuid)
    stmt.setInt(2, Math.floor(amount))
    stmt.setInt(3, Math.floor(amount))
    stmt.executeUpdate()
    return true
  } catch(e) {
    console.error('[KubeShop] addBalance error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function removeBalance(server, uuid, amount) {
  if (amount < 0) return false
  let toRemove = Math.floor(amount)
  let conn = null
  let stmt = null
  let rs = null
  try {
    conn = getConnection()
    // Check current balance first
    stmt = conn.prepareStatement('SELECT balance FROM kubeshop_wallets WHERE uuid = ?')
    stmt.setString(1, uuid)
    rs = stmt.executeQuery()
    let currentBalance = 0
    if (rs.next()) {
      currentBalance = rs.getInt('balance')
    }
    closeQuietly(rs)
    closeQuietly(stmt)

    if (currentBalance < toRemove) return false

    // Update balance
    stmt = conn.prepareStatement('UPDATE kubeshop_wallets SET balance = balance - ? WHERE uuid = ? AND balance >= ?')
    stmt.setInt(1, toRemove)
    stmt.setString(2, uuid)
    stmt.setInt(3, toRemove)
    let updated = stmt.executeUpdate()
    return updated > 0
  } catch(e) {
    console.error('[KubeShop] removeBalance error: ' + e)
    return false
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function hasBalance(server, uuid, amount) {
  return getBalance(server, uuid) >= Math.floor(amount)
}

function formatBalance(amount) {
  return "$" + amount
}

// ============================================================================
// SHOP SYSTEM - MySQL Functions
// ============================================================================

function saveShop(server, signKey, shopData) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement(
      'INSERT INTO kubeshop_shops (sign_key, owner_uuid, chest_pos, shop_type, price, item_template) ' +
      'VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE owner_uuid = ?, chest_pos = ?, shop_type = ?, price = ?, item_template = ?'
    )
    stmt.setString(1, signKey)
    stmt.setString(2, shopData.owner)
    stmt.setString(3, shopData.chestPos)
    stmt.setString(4, shopData.type)
    stmt.setInt(5, shopData.price)
    stmt.setString(6, shopData.itemTemplate)
    // ON DUPLICATE KEY UPDATE values
    stmt.setString(7, shopData.owner)
    stmt.setString(8, shopData.chestPos)
    stmt.setString(9, shopData.type)
    stmt.setInt(10, shopData.price)
    stmt.setString(11, shopData.itemTemplate)
    stmt.executeUpdate()
    // Update cache immediately
    shopSignKeysCache[signKey] = true
  } catch(e) {
    console.error('[KubeShop] saveShop error: ' + e)
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function removeShop(server, signKey) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('DELETE FROM kubeshop_shops WHERE sign_key = ?')
    stmt.setString(1, signKey)
    stmt.executeUpdate()
    // Update cache immediately
    delete shopSignKeysCache[signKey]
  } catch(e) {
    console.error('[KubeShop] removeShop error: ' + e)
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

// Flags only - saveShop leaves them alone on its ON DUPLICATE KEY UPDATE, so a
// shop re-saved over an existing sign keeps whatever an admin set.
function setShopFlags(server, signKey, isServer, isInfinite) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('UPDATE kubeshop_shops SET is_server = ?, is_infinite = ? WHERE sign_key = ?')
    stmt.setInt(1, isServer ? 1 : 0)
    stmt.setInt(2, isInfinite ? 1 : 0)
    stmt.setString(3, signKey)
    return stmt.executeUpdate() > 0
  } catch(e) {
    console.error('[KubeShop] setShopFlags error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function getShop(signKey) {
  let conn = null
  let stmt = null
  let rs = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('SELECT * FROM kubeshop_shops WHERE sign_key = ?')
    stmt.setString(1, signKey)
    rs = stmt.executeQuery()
    if (rs.next()) {
      return {
        owner: rs.getString('owner_uuid'),
        chestPos: rs.getString('chest_pos'),
        type: rs.getString('shop_type'),
        price: rs.getInt('price'),
        itemTemplate: rs.getString('item_template'),
        isServer: rs.getInt('is_server') === 1,
        isInfinite: rs.getInt('is_infinite') === 1
      }
    }
    return null
  } catch(e) {
    console.error('[KubeShop] getShop error: ' + e)
    return null
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function getAllShops() {
  let conn = null
  let stmt = null
  let rs = null
  let shops = {}
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('SELECT * FROM kubeshop_shops')
    rs = stmt.executeQuery()
    while (rs.next()) {
      let signKey = rs.getString('sign_key')
      shops[signKey] = {
        owner: rs.getString('owner_uuid'),
        chestPos: rs.getString('chest_pos'),
        type: rs.getString('shop_type'),
        price: rs.getInt('price'),
        itemTemplate: rs.getString('item_template'),
        isServer: rs.getInt('is_server') === 1,
        isInfinite: rs.getInt('is_infinite') === 1
      }
    }
    return shops
  } catch(e) {
    console.error('[KubeShop] getAllShops error: ' + e)
    return {}
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function getShopsByChestPos(chestPos) {
  let conn = null
  let stmt = null
  let rs = null
  let results = []
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('SELECT sign_key FROM kubeshop_shops WHERE chest_pos = ?')
    stmt.setString(1, chestPos)
    rs = stmt.executeQuery()
    while (rs.next()) {
      results.push(rs.getString('sign_key'))
    }
    return results
  } catch(e) {
    console.error('[KubeShop] getShopsByChestPos error: ' + e)
    return []
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

// ============================================================================
// PLOT SYSTEM - Purchasable chunks (MySQL Functions)
// ============================================================================

// Chunk the player stands in. Dimension string matches what getBlockKey() uses.
function getPlayerPlot(player) {
  let dim = String(player.getLevel().getDimension())
  return {
    dim: dim,
    cx: Math.floor(player.getX() / 16),
    cz: Math.floor(player.getZ() / 16),
    key: dim + '_' + Math.floor(player.getX() / 16) + '_' + Math.floor(player.getZ() / 16)
  }
}

// "ResourceKey[minecraft:dimension / minecraft:overworld]" -> "minecraft:overworld"
function dimIdOf(dimString) {
  let m = String(dimString).match(/([a-z0-9_.-]+:[a-z0-9_.\/-]+)\s*\]?$/)
  return m ? m[1] : 'minecraft:overworld'
}

// salePrice is the owner's own asking price, null when they are not reselling.
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

// What players see instead of chunk coordinates.
function plotLabel(plot) {
  return plot.name ? plot.name : 'Unnamed plot'
}

// "Plot 7" for the next plot an admin puts up, continuing the highest number so
// far. Renumbering after a deletion is fine - names are labels, not keys.
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
    console.error('[KubeShop] nextPlotName error: ' + e)
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
    console.error('[KubeShop] getPlot error: ' + e)
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
    console.error('[KubeShop] savePlot error: ' + e)
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
    console.error('[KubeShop] deletePlot error: ' + e)
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
    console.error('[KubeShop] takePlot error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

// Owner lists their own plot for resale (price null takes it off the market).
// Guarded on owner so a stale command cannot list somebody else's plot.
function setPlotSalePrice(plotKey, ownerUuid, price) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement('UPDATE kubeshop_plots SET sale_price = ? WHERE plot_key = ? AND owner_uuid = ?')
    if (price === null) {
      stmt.setNull(1, SqlTypes.INTEGER)
    } else {
      stmt.setInt(1, price)
    }
    stmt.setString(2, plotKey)
    stmt.setString(3, ownerUuid)
    return stmt.executeUpdate() > 0
  } catch(e) {
    console.error('[KubeShop] setPlotSalePrice error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

// Move a listed plot to its buyer. Guarded on seller AND asking price, so a plot
// relisted or sold a moment earlier cannot be bought at the stale price.
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
    console.error('[KubeShop] transferPlot error: ' + e)
    return false
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

// Put a transferred plot back the way it was, when payment falls through.
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
    console.error('[KubeShop] restoreListing error: ' + e)
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
    console.error('[KubeShop] releasePlot error: ' + e)
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
    while (rs.next()) {
      plots.push(readPlotRow(rs))
    }
    return plots
  } catch(e) {
    console.error('[KubeShop] getAllPlots error: ' + e)
    return []
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

// The name column is VARCHAR(64); a longer one makes the INSERT fail with
// nothing but a log line to show for it.
function validPlotName(source, name) {
  // Brigadier hands back a Java string, whose .length is a method, not a number.
  name = String(name).trim()
  if (!name) {
    source.sendFailure(Component.red("Give the plot a name"))
    return null
  }
  if (name.length > 64) {
    source.sendFailure(Component.red("Plot names are 64 characters at most"))
    return null
  }
  return name
}

// ============================================================================
// TRANSACTION HISTORY SYSTEM - MySQL Functions
// ============================================================================

function addHistoryEntry(server, playerUuid, type, amount, otherPlayer, description) {
  let conn = null
  let stmt = null
  try {
    conn = getConnection()
    stmt = conn.prepareStatement(
      'INSERT INTO kubeshop_history (player_uuid, type, amount, other_player, description) ' +
      'VALUES (?, ?, ?, ?, ?)'
    )
    stmt.setString(1, playerUuid)
    stmt.setString(2, type)
    stmt.setInt(3, amount)
    if (otherPlayer) {
      stmt.setString(4, otherPlayer)
    } else {
      stmt.setNull(4, SqlTypes.VARCHAR)
    }
    if (description) {
      stmt.setString(5, description)
    } else {
      stmt.setNull(5, SqlTypes.VARCHAR)
    }
    stmt.executeUpdate()

    // Trim old entries if over limit
    closeQuietly(stmt)
    stmt = conn.prepareStatement(
      'DELETE FROM kubeshop_history WHERE player_uuid = ? AND id NOT IN (' +
      '  SELECT id FROM (SELECT id FROM kubeshop_history WHERE player_uuid = ? ORDER BY created_at DESC LIMIT ?) AS t' +
      ')'
    )
    stmt.setString(1, playerUuid)
    stmt.setString(2, playerUuid)
    stmt.setInt(3, MAX_HISTORY_PER_PLAYER)
    stmt.executeUpdate()
  } catch(e) {
    console.error('[KubeShop] addHistoryEntry error: ' + e)
  } finally {
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function getHistory(server, playerUuid) {
  let conn = null
  let stmt = null
  let rs = null
  let history = []
  try {
    conn = getConnection()
    stmt = conn.prepareStatement(
      'SELECT * FROM kubeshop_history WHERE player_uuid = ? ORDER BY created_at DESC LIMIT ?'
    )
    stmt.setString(1, playerUuid)
    stmt.setInt(2, MAX_HISTORY_PER_PLAYER)
    rs = stmt.executeQuery()
    while (rs.next()) {
      history.push({
        type: rs.getString('type'),
        amount: rs.getInt('amount'),
        other: rs.getString('other_player'),
        desc: rs.getString('description'),
        time: rs.getTimestamp('created_at').getTime()
      })
    }
    return history
  } catch(e) {
    console.error('[KubeShop] getHistory error: ' + e)
    return []
  } finally {
    closeQuietly(rs)
    closeQuietly(stmt)
    closeQuietly(conn)
  }
}

function formatTimestamp(timestamp) {
  let date = new Date(timestamp)
  let month = date.getMonth() + 1
  let day = date.getDate()
  let hours = date.getHours()
  let minutes = date.getMinutes()
  return (month < 10 ? "0" : "") + month + "/" +
         (day < 10 ? "0" : "") + day + " " +
         (hours < 10 ? "0" : "") + hours + ":" +
         (minutes < 10 ? "0" : "") + minutes
}

// ============================================================================
// COIN SYSTEM - Helper Functions (NBT-based paper items)
// ============================================================================

// Create a coin item. 1.20.1 stores this as NBT; the 1.21 data-component
// syntax used on ATM10 does not exist here.
function createCoinItem(denom, count) {
  let nbt = '{CustomModelData:' + denom.customModelData + ',' +
    'display:{' +
    'Name:\'{"text":"' + denom.name + '","color":"' + denom.color + '","italic":false}\',' +
    'Lore:[\'{"text":"' + denom.lore + '","color":"gray","italic":false}\']' +
    '}}'
  return Item.of(COIN_BASE_ITEM, count, nbt)
}

// Get the CustomModelData from an item stack (returns 0 if not present).
// 1.20.1 keeps it in plain NBT, so this is far simpler than the 1.21 component
// version on ATM10.
function getItemCustomModelData(stack) {
  if (!stack || stack.isEmpty()) return 0

  try {
    if (!stack.hasNBT || !stack.hasNBT()) return 0
    let nbt = stack.getNbt()
    if (!nbt || !nbt.contains('CustomModelData')) return 0
    return nbt.getInt('CustomModelData')
  } catch(e) {
    console.warn("[KubeShop] Error reading CustomModelData: " + e)
  }

  return 0
}

// Get the coin denomination info from an item stack (returns null if not a coin)
function getCoinDenomFromStack(stack) {
  if (!stack || stack.isEmpty()) return null
  if (stack.getId() !== COIN_BASE_ITEM) return null

  let customModelData = getItemCustomModelData(stack)
  if (customModelData === 0) return null

  for (let i = 0; i < COIN_DENOMINATIONS.length; i++) {
    if (COIN_DENOMINATIONS[i].customModelData === customModelData) {
      return COIN_DENOMINATIONS[i]
    }
  }
  return null
}

// Get the value of a coin item stack (returns 0 if not a coin)
function getCoinValue(stack) {
  let denom = getCoinDenomFromStack(stack)
  return denom ? denom.value : 0
}

// Count all coins in player inventory and return total value + breakdown
function countPlayerCoins(player) {
  let inv = player.getInventory()
  let slots = inv.getSlots ? inv.getSlots() : (inv.size ? inv.size() : 36)
  let total = 0
  let breakdown = {}

  for (let i = 0; i < COIN_DENOMINATIONS.length; i++) {
    breakdown[COIN_DENOMINATIONS[i].customModelData] = 0
  }

  for (let i = 0; i < slots; i++) {
    let stack = inv.getStackInSlot ? inv.getStackInSlot(i) : inv.getItem(i)
    if (stack && !stack.isEmpty()) {
      let denom = getCoinDenomFromStack(stack)
      if (denom) {
        let count = stack.getCount()
        total += denom.value * count
        breakdown[denom.customModelData] = (breakdown[denom.customModelData] || 0) + count
      }
    }
  }

  return { total: total, breakdown: breakdown }
}

// Give coins to player using greedy algorithm (fewest coins possible)
function giveCoinsEfficient(player, amount) {
  let remaining = amount

  for (let i = 0; i < COIN_DENOMINATIONS.length; i++) {
    let denom = COIN_DENOMINATIONS[i]
    if (remaining >= denom.value) {
      let count = Math.floor(remaining / denom.value)
      remaining = remaining % denom.value

      while (count > 0) {
        let stackSize = Math.min(count, 64)
        player.give(createCoinItem(denom, stackSize))
        count -= stackSize
      }
    }
  }
}

// Give coins of a specific denomination
function giveCoinsSpecific(player, amount, denomination) {
  let denomInfo = null
  for (let i = 0; i < COIN_DENOMINATIONS.length; i++) {
    if (COIN_DENOMINATIONS[i].value === denomination) {
      denomInfo = COIN_DENOMINATIONS[i]
      break
    }
  }

  if (!denomInfo) return false
  if (amount % denomination !== 0) return false

  let count = amount / denomination

  while (count > 0) {
    let stackSize = Math.min(count, 64)
    player.give(createCoinItem(denomInfo, stackSize))
    count -= stackSize
  }

  return true
}

// Remove coins from player inventory worth the specified amount (greedy, largest first)
function removeCoinsFromPlayer(player, amount) {
  if (!canPayExactWithCoins(player, amount)) return false

  let inv = player.getInventory()
  let slots = inv.getSlots ? inv.getSlots() : (inv.size ? inv.size() : 36)
  let remaining = amount

  for (let d = 0; d < COIN_DENOMINATIONS.length && remaining > 0; d++) {
    let denom = COIN_DENOMINATIONS[d]

    for (let i = 0; i < slots && remaining > 0; i++) {
      let stack = inv.getStackInSlot ? inv.getStackInSlot(i) : inv.getItem(i)
      let stackDenom = getCoinDenomFromStack(stack)
      if (stackDenom && stackDenom.customModelData === denom.customModelData) {
        let stackCount = stack.getCount()
        let maxCanUse = Math.floor(remaining / denom.value)
        let toRemove = Math.min(stackCount, maxCanUse)

        if (toRemove > 0) {
          stack.shrink(toRemove)
          if (stack.isEmpty()) {
            inv.setItem(i, Item.of('minecraft:air'))
          } else {
            inv.setItem(i, stack)
          }
          remaining -= toRemove * denom.value
        }
      }
    }
  }

  return remaining === 0
}

// Check if player can pay exact amount with their coins
function canPayExactWithCoins(player, amount) {
  let coinInfo = countPlayerCoins(player)
  if (coinInfo.total < amount) return false

  let remaining = amount
  for (let d = 0; d < COIN_DENOMINATIONS.length && remaining > 0; d++) {
    let denom = COIN_DENOMINATIONS[d]
    let available = coinInfo.breakdown[denom.customModelData] || 0
    let maxCanUse = Math.floor(remaining / denom.value)
    let toUse = Math.min(available, maxCanUse)
    remaining -= toUse * denom.value
  }

  return remaining === 0
}

// ============================================================================
// BLOCK HELPER FUNCTIONS
// ============================================================================

function getBlockKey(block) {
  let pos = block.getPos()
  let dim = block.getLevel().getDimension().toString()
  return pos.getX() + "_" + pos.getY() + "_" + pos.getZ() + "_" + dim
}

function isWallSign(block) {
  let blockId = block.getId()
  return blockId.indexOf("wall_sign") !== -1
}

function isContainer(block) {
  let blockId = block.getId()
  if (blockId.indexOf("ender_chest") !== -1) return false
  let inv = block.getInventory()
  return inv !== null && inv !== undefined
}

function getAttachedBlock(signBlock) {
  let stateStr = signBlock.getBlockState().toString()
  let facing = null

  let facingStart = stateStr.indexOf("facing=")
  if (facingStart !== -1) {
    let facingEnd = stateStr.indexOf(",", facingStart)
    if (facingEnd === -1) {
      facingEnd = stateStr.indexOf("]", facingStart)
    }
    facing = stateStr.substring(facingStart + 7, facingEnd)
  }

  if (facing === "east") return signBlock.getWest()
  if (facing === "west") return signBlock.getEast()
  if (facing === "north") return signBlock.getSouth()
  if (facing === "south") return signBlock.getNorth()
  return null
}

function extractDigits(str) {
  let result = ""
  for (let i = 0; i < str.length; i++) {
    let c = str.charAt(i)
    if (c >= "0" && c <= "9") {
      result += c
    }
  }
  return result
}

function unquoteSignText(str) {
  try {
    let parsed = JSON.parse(str)
    if (typeof parsed === "string") {
      return parsed
    }
    if (typeof parsed === "object" && parsed !== null && parsed.text) {
      return parsed.text
    }
  } catch (e) {}

  if (str.length >= 2 && str.charCodeAt(0) === 34 && str.charCodeAt(str.length - 1) === 34) {
    return str.substring(1, str.length - 1)
  }

  return str
}

// ============================================================================
// SIGN TEXT PARSING
// ============================================================================

function parseSignText(signBlock) {
  let nbt = signBlock.getEntityData()
  if (!nbt) {
    console.warn("[KubeShop] No entity data on sign")
    return null
  }

  let frontText = nbt.getCompound("front_text")
  if (!frontText) {
    console.warn("[KubeShop] No front_text in sign NBT")
    return null
  }

  let messages = frontText.getList("messages", 8)
  if (!messages || messages.size() < 4) {
    console.warn("[KubeShop] Invalid messages in sign NBT")
    return null
  }

  let line1 = unquoteSignText(messages.getString(0))
  let shopType = null

  let line1Upper = line1.toUpperCase()
  if (line1Upper.indexOf("[BUY]") !== -1) {
    shopType = "BUY"
  } else if (line1Upper.indexOf("[SELL]") !== -1) {
    shopType = "SELL"
  }

  if (!shopType) {
    console.warn("[KubeShop] No [BUY] or [SELL] found on sign")
    return null
  }

  let line4 = unquoteSignText(messages.getString(3))
  let priceStr = extractDigits(line4)
  let price = parseInt(priceStr)

  if (isNaN(price) || price < 0) {
    console.warn("[KubeShop] Invalid price on sign")
    return null
  }

  return { type: shopType, price: price }
}

function updateSignForShop(signBlock, shopType, price) {
  let nbt = signBlock.getEntityData()
  if (!nbt) return

  let frontText = nbt.getCompound("front_text")
  if (!frontText) return

  let messages = frontText.getList("messages", 8)
  if (!messages || messages.size() < 4) return

  let line2Original = messages.getString(1)
  let line3Original = messages.getString(2)

  let line1Component = '{"text":"[' + shopType + ']","color":"yellow"}'
  let line4Component = '{"text":"' + price + '$","color":"green"}'

  let newMessages = NBT.listTag()
  newMessages.add(NBT.stringTag(line1Component))
  newMessages.add(NBT.stringTag(line2Original))
  newMessages.add(NBT.stringTag(line3Original))
  newMessages.add(NBT.stringTag(line4Component))

  frontText.put("messages", newMessages)
  nbt.put("front_text", frontText)

  nbt.putByte("is_waxed", 1)

  signBlock.setEntityData(nbt)

  let level = signBlock.getLevel()
  let pos = signBlock.getPos()
  let state = signBlock.getBlockState()
  level.sendBlockUpdated(pos, state, state, 3)
}

// ============================================================================
// INVENTORY HELPERS
// ============================================================================

function serializeInventory(chestBlock) {
  let inv = chestBlock.getInventory()
  if (!inv) return "[]"

  let items = []
  let slots = inv.getSlots ? inv.getSlots() : (inv.size ? inv.size() : 27)

  for (let i = 0; i < slots; i++) {
    let stack = null
    if (inv.getStackInSlot) {
      stack = inv.getStackInSlot(i)
    } else if (inv.getItem) {
      stack = inv.getItem(i)
    }

    if (stack && !stack.isEmpty()) {
      items.push({
        id: stack.getId(),
        count: stack.getCount(),
        nbt: stack.hasNBT && stack.hasNBT() ? stack.getNbt().toString() : null
      })
    }
  }

  return JSON.stringify(items)
}

function chestHasItems(chestBlock, itemTemplateJson) {
  let missing = getMissingItems(chestBlock.getInventory(), itemTemplateJson)
  return missing.length === 0
}

function getMissingItems(inv, itemTemplateJson) {
  let template = JSON.parse(itemTemplateJson)
  if (!inv) return template.map(function(item) { return item.id })

  let needed = {}
  for (let i = 0; i < template.length; i++) {
    let item = template[i]
    let key = item.id
    needed[key] = (needed[key] || 0) + item.count
  }

  let slots = inv.getSlots ? inv.getSlots() : (inv.size ? inv.size() : 27)
  for (let i = 0; i < slots; i++) {
    let stack = inv.getStackInSlot ? inv.getStackInSlot(i) : inv.getItem(i)
    if (stack && !stack.isEmpty()) {
      let key = stack.getId()
      if (needed[key]) {
        needed[key] -= stack.getCount()
      }
    }
  }

  let missing = []
  for (let key in needed) {
    if (needed[key] > 0) {
      let simpleName = key.replace("minecraft:", "").replace(/_/g, " ")
      simpleName = simpleName.split(" ").map(function(word) {
        return word.charAt(0).toUpperCase() + word.slice(1)
      }).join(" ")
      missing.push(needed[key] + "x " + simpleName)
    }
  }
  return missing
}

function removeItemsFromChest(chestBlock, itemTemplateJson) {
  let template = JSON.parse(itemTemplateJson)
  let inv = chestBlock.getInventory()
  if (!inv) return false

  let toRemove = {}
  for (let i = 0; i < template.length; i++) {
    let item = template[i]
    let key = item.id
    toRemove[key] = (toRemove[key] || 0) + item.count
  }

  let slots = inv.getSlots ? inv.getSlots() : (inv.size ? inv.size() : 27)
  for (let i = 0; i < slots; i++) {
    let stack = inv.getStackInSlot ? inv.getStackInSlot(i) : inv.getItem(i)
    if (stack && !stack.isEmpty()) {
      let key = stack.getId()
      if (toRemove[key] && toRemove[key] > 0) {
        let removeCount = Math.min(toRemove[key], stack.getCount())
        if (inv.extractItem) {
          inv.extractItem(i, removeCount, false)
        } else {
          stack.shrink(removeCount)
        }
        toRemove[key] -= removeCount
      }
    }
  }

  return true
}

function playerHasItems(player, itemTemplateJson) {
  return getMissingPlayerItems(player, itemTemplateJson).length === 0
}

function getMissingPlayerItems(player, itemTemplateJson) {
  let template = JSON.parse(itemTemplateJson)
  let inv = player.getInventory()

  let needed = {}
  for (let i = 0; i < template.length; i++) {
    let item = template[i]
    let key = item.id
    needed[key] = (needed[key] || 0) + item.count
  }

  let slots = inv.getSlots ? inv.getSlots() : (inv.size ? inv.size() : 36)
  for (let i = 0; i < slots; i++) {
    let stack = inv.getStackInSlot ? inv.getStackInSlot(i) : inv.getItem(i)
    if (stack && !stack.isEmpty()) {
      let key = stack.getId()
      if (needed[key]) {
        needed[key] -= stack.getCount()
      }
    }
  }

  let missing = []
  for (let key in needed) {
    if (needed[key] > 0) {
      let simpleName = key.replace("minecraft:", "").replace(/_/g, " ")
      simpleName = simpleName.split(" ").map(function(word) {
        return word.charAt(0).toUpperCase() + word.slice(1)
      }).join(" ")
      missing.push(needed[key] + "x " + simpleName)
    }
  }
  return missing
}

function removeItemsFromPlayer(player, itemTemplateJson) {
  let template = JSON.parse(itemTemplateJson)
  let inv = player.getInventory()

  let toRemove = {}
  for (let i = 0; i < template.length; i++) {
    let item = template[i]
    let key = item.id
    toRemove[key] = (toRemove[key] || 0) + item.count
  }

  let slots = inv.getSlots ? inv.getSlots() : (inv.size ? inv.size() : 36)
  for (let i = 0; i < slots; i++) {
    let stack = inv.getStackInSlot ? inv.getStackInSlot(i) : inv.getItem(i)
    if (stack && !stack.isEmpty()) {
      let key = stack.getId()
      if (toRemove[key] && toRemove[key] > 0) {
        let removeCount = Math.min(toRemove[key], stack.getCount())
        if (inv.extractItem) {
          inv.extractItem(i, removeCount, false)
        } else {
          stack.shrink(removeCount)
        }
        toRemove[key] -= removeCount
      }
    }
  }

  return true
}

function giveItemsToPlayer(player, itemTemplateJson) {
  let template = JSON.parse(itemTemplateJson)

  for (let i = 0; i < template.length; i++) {
    let item = template[i]
    player.give(Item.of(item.id, item.count))
  }
}

function addItemsToChest(chestBlock, itemTemplateJson) {
  let template = JSON.parse(itemTemplateJson)
  let inv = chestBlock.getInventory()
  if (!inv) return false

  for (let i = 0; i < template.length; i++) {
    let item = template[i]
    let stack = Item.of(item.id, item.count)
    if (inv.insertItem) {
      let remaining = inv.insertItem(stack, false)
      if (remaining && !remaining.isEmpty()) {
        return false
      }
    } else {
      let inserted = false
      let slots = inv.getSlots ? inv.getSlots() : (inv.size ? inv.size() : 27)
      for (let s = 0; s < slots && !inserted; s++) {
        let existing = inv.getStackInSlot ? inv.getStackInSlot(s) : inv.getItem(s)
        if (!existing || existing.isEmpty()) {
          if (inv.setItem) inv.setItem(s, stack)
          inserted = true
        }
      }
      if (!inserted) return false
    }
  }

  return true
}

function chestHasSpace(chestBlock, itemTemplateJson) {
  let template = JSON.parse(itemTemplateJson)
  let inv = chestBlock.getInventory()
  if (!inv) return false

  let emptySlots = 0
  let slots = inv.getSlots ? inv.getSlots() : (inv.size ? inv.size() : 27)
  for (let i = 0; i < slots; i++) {
    let stack = inv.getStackInSlot ? inv.getStackInSlot(i) : inv.getItem(i)
    if (!stack || stack.isEmpty()) {
      emptySlots++
    }
  }

  return emptySlots >= template.length
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

// Claim-protection bypass for shop signs.
//
// ATM10 uses FTB Chunks, whose API can toggle a per-player protection bypass so
// a buyer can click a shop sign inside the owner's claim. DeceasedCraft uses
// Open Parties and Claims instead, which exposes no equivalent bypass, so the
// same problem is solved in OPAC's config: "hand$minecraft:*_wall_sign" is in
// forcedBlockProtectionExceptionList, letting an empty-handed right-click on a
// wall sign through to this script inside any claim.
//
// The lookup below stays so the code path is identical on both packs; on
// DeceasedCraft it simply never resolves and every bypass call is a no-op.
let FTBChunksAPI = null
let ftbChunksAvailable = false

try {
  FTBChunksAPI = Java.loadClass('dev.ftb.mods.ftbchunks.api.FTBChunksAPI')
  ftbChunksAvailable = true
  console.info("[KubeShop] FTB Chunks API loaded")
} catch(e) {
  console.info("[KubeShop] FTB Chunks not installed - relying on the OPAC wall-sign exception for shops inside claims")
}

// Track which players currently have bypass enabled (in-memory only, OK to lose on reload)
let playersWithBypass = {}

// Get FTB Chunks manager safely
function getFTBChunksManager() {
  if (!ftbChunksAvailable || !FTBChunksAPI) {
    return null
  }
  try {
    let api = FTBChunksAPI.api()
    if (api && api.isManagerLoaded()) {
      return api.getManager()
    }
  } catch(e) {
    console.warn("[KubeShop] Error getting FTB Chunks manager: " + e)
  }
  return null
}

// Get proper Java UUID from player
function getPlayerUUID(player) {
  try {
    if (player.getUUID) {
      return player.getUUID()
    }
  } catch(e) {}

  try {
    if (player.uuid) {
      return player.uuid
    }
  } catch(e) {}

  try {
    let uuidStr = player.getStringUuid()
    let UUID = Java.loadClass('java.util.UUID')
    return UUID.fromString(uuidStr)
  } catch(e) {}

  return null
}

// Enable bypass for a player
function enableShopBypass(player) {
  let manager = getFTBChunksManager()
  if (!manager) return false

  let uuid = getPlayerUUID(player)
  let uuidStr = player.getStringUuid()

  if (!uuid) return false

  try {
    if (manager.getBypassProtection(uuid)) return false
    manager.setBypassProtection(uuid, true)
    if (manager.getBypassProtection(uuid)) {
      playersWithBypass[uuidStr] = player.getName().getString()
      return true
    }
  } catch(e) {
    console.error("[KubeShop] Error setting bypass: " + e)
  }

  return false
}

// Disable bypass for a player
function disableShopBypass(player) {
  let manager = getFTBChunksManager()
  if (!manager) return

  let uuid = getPlayerUUID(player)
  let uuidStr = player.getStringUuid()

  if (playersWithBypass[uuidStr] && uuid) {
    try {
      manager.setBypassProtection(uuid, false)
    } catch(e) {
      console.error("[KubeShop] Error disabling bypass: " + e)
    }
    delete playersWithBypass[uuidStr]
  }
}

// ============================================================================
// CHUNK CLAIMS - Open Parties and Claims
// ============================================================================
//
// Plots claim the chunk they sit in for their owner. ATM10 does this through FTB
// Chunks, which claims for a team and so only works for an online player; OPAC
// claims by UUID, so an offline player can be given a plot outright.
//
// Everything degrades to "the plot is still recorded, nothing was claimed" when
// the mod or its API is missing, which is what the FTB path does too.
let OpenPACServerAPI = null
let ResourceLocationClass = null
let serverClaimUuid = null
let opacAvailable = false

try {
  OpenPACServerAPI = Java.loadClass('xaero.pac.common.server.api.OpenPACServerAPI')
  ResourceLocationClass = Java.loadClass('net.minecraft.resources.ResourceLocation')
  opacAvailable = true
  console.info("[KubeShop] Open Parties and Claims API loaded")
} catch(e) {
  console.info("[KubeShop] OPAC API not available - plots will be recorded but not auto-claimed: " + e)
}

// Which UUID owns a server claim, i.e. a plot an admin is holding until it sells.
// Recent OPAC publishes it as SpecialClaimOwners.SERVER; 0.25.8, the build
// DeceasedCraft ships, only has it on the internal config class. Without it a
// server-held chunk simply reads as somebody else's claim and a buy is refused.
if (opacAvailable) {
  try {
    serverClaimUuid = Java.loadClass('xaero.pac.common.claims.api.SpecialClaimOwners').SERVER
  } catch(e) {
    try {
      serverClaimUuid = Java.loadClass('xaero.pac.common.server.player.config.PlayerConfig').SERVER_CLAIM_UUID
    } catch(e2) {
      console.warn("[KubeShop] OPAC server-claim UUID not found: " + e2)
    }
  }
}

function getClaimsManager(server) {
  if (!opacAvailable) return null
  try {
    let api = OpenPACServerAPI.get(server)
    try {
      return api.getServerClaimsManager()
    } catch(e) {
      return api.serverClaimsManager
    }
  } catch(e) {
    console.warn("[KubeShop] OPAC claims manager unavailable: " + e)
    return null
  }
}

// Rhino can expose a no-arg getter as a property instead of a method, the same
// trap getPlayerUUID() already works around.
function claimOwnerId(claim) {
  try {
    return claim.getPlayerId()
  } catch(e) {
    return claim.playerId
  }
}

function javaUuid(uuidStr) {
  return Java.loadClass('java.util.UUID').fromString(String(uuidStr))
}

// Who owns the chunk the player stands in. Pass a seller's uuid to also learn
// whether the claim is already theirs (a plot being resold).
// All false/null when OPAC is absent, i.e. nothing can be auto-claimed.
function getChunkClaimState(player, otherUuidStr) {
  let state = { claimed: false, mine: false, server: false, otherMember: false, ownerName: null }
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
    state.ownerName = state.server
      ? "the server"
      : getPlayerNameByUuid(player.getServer(), String(ownerId))
    if (otherUuidStr) state.otherMember = ownerId.equals(javaUuid(otherUuidStr))
  } catch(e) {
    console.error('[KubeShop] getChunkClaimState error: ' + e)
  }
  return state
}

// Claim the chunk the player stands in for ownerUuidStr, releasing whatever sits
// on it first. Callers check with getChunkClaimState() that the existing claim is
// theirs to release before getting here - this API skips OPAC's own limit and
// permission checks, which is the point for a plot that was paid for.
function claimChunkFor(player, ownerUuidStr) {
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
    console.error('[KubeShop] auto-claim failed: ' + e)
    return { ok: false, msg: String(e) }
  }
}

// Drop whatever claim sits on the chunk the player stands in, whoever owns it.
// Used when an admin pulls a plot back from a player who stopped playing.
function unclaimChunkAt(player) {
  let manager = getClaimsManager(player.getServer())
  if (!manager) return { ok: false, msg: 'Open Parties and Claims is not available' }

  try {
    let pos = getPlayerPlot(player)
    manager.unclaim(new ResourceLocationClass(dimIdOf(pos.dim)), pos.cx, pos.cz)
    return { ok: true, msg: null }
  } catch(e) {
    console.error('[KubeShop] unclaim failed: ' + e)
    return { ok: false, msg: String(e) }
  }
}

// Check if sign is waxed
function isSignWaxed(block) {
  try {
    let nbt = block.getEntityData()
    if (!nbt) return false
    return nbt.getByte("is_waxed") === 1
  } catch(e) {
    return false
  }
}

// Check if player is looking at a valid shop sign (must be waxed)
// Uses lightweight cache to avoid DB queries every tick
function getShopSignPlayerIsLookingAt(player) {
  try {
    let hitResult = player.rayTrace(5, false)
    if (!hitResult) return null

    let block = hitResult.block
    if (!block) return null

    let blockId = block.getId()
    if (!blockId.includes('sign')) return null

    if (!isSignWaxed(block)) return null

    let signKey = getBlockKey(block)

    // Use cache instead of DB query
    if (!isShopSignKey(signKey)) return null

    return { block: block, signKey: signKey }
  } catch(e) {
    return null
  }
}

// Server tick - manage bypass protection for players looking at shop signs
ServerEvents.tick(event => {
  let tickCount = event.server.getTickCount()

  // Refresh shop sign keys cache periodically
  if (tickCount - shopSignKeysCacheLastRefresh >= SHOP_CACHE_REFRESH_TICKS) {
    refreshShopSignKeysCache()
    shopSignKeysCacheLastRefresh = tickCount
  }

  // Only check every 2 ticks for responsiveness
  if (tickCount % 2 !== 0) return

  // Skip if FTB Chunks not available
  if (!ftbChunksAvailable) return

  // Process all online players
  event.server.getPlayers().forEach(player => {
    let uuidStr = player.getStringUuid()
    let hasCurrentBypass = playersWithBypass[uuidStr] || false

    let shopInfo = getShopSignPlayerIsLookingAt(player)
    let shouldHaveBypass = (shopInfo !== null)

    if (shouldHaveBypass && !hasCurrentBypass) {
      enableShopBypass(player)
    } else if (!shouldHaveBypass && hasCurrentBypass) {
      disableShopBypass(player)
    }
  })

  // Safety: Clean up bypass for any offline players
  for (let uuidStr in playersWithBypass) {
    let stillOnline = false
    event.server.getPlayers().forEach(p => {
      if (p.getStringUuid() === uuidStr) stillOnline = true
    })
    if (!stillOnline) {
      delete playersWithBypass[uuidStr]
    }
  }
})

// Clean up bypass when player disconnects
PlayerEvents.loggedOut(event => {
  let player = event.player
  let uuidStr = player.getStringUuid()

  if (playersWithBypass[uuidStr]) {
    disableShopBypass(player)
  }
})

// Handle block breaking - protect shops first, then clean up.
//
// A shop sign or shop chest is removable only by the player who owns every shop
// on it.
//
// This is NOT the ATM10 hole. There, kubeshop hands out FTB Chunks' global
// protection bypass while a player aims at a shop sign, and that bypass covers
// breaking too - which is how two signs and the chest behind them went on
// 2026-08-23. This pack has no FTB Chunks; shops inside a claim work through
// OPAC's "hand$minecraft:*_wall_sign" entry in forcedBlockProtectionExceptionList,
// and "hand$" is an empty-handed right-click only. There is no "break$" entry for
// signs, so OPAC has always refused the break. The playersWithBypass branch below
// is inert here and is kept only so both packs read the same.
//
// What this guard does add: shops standing on unclaimed land had no protection at
// all, and inside a claim OPAC authorises by claim membership rather than shop
// ownership - so a claim's own party members could delete someone else's shop.
// Ownership decides now, everywhere.
BlockEvents.broken(event => {
  let blockKey = getBlockKey(event.block)
  let player = event.getEntity()
  let wasSign = isWallSign(event.block)

  // Which shops does this block carry? A sign is its own shop; a container is
  // whatever signs point at it.
  let shopOwners = []
  let brokenSignKeys = []
  let serverShop = false

  if (wasSign) {
    let shop = getShop(blockKey)
    if (shop) {
      shopOwners.push(shop.owner)
      if (shop.isServer) serverShop = true
      brokenSignKeys.push(blockKey)
    }
  } else if (isContainer(event.block)) {
    let signKeys = getShopsByChestPos(blockKey)
    for (let i = 0; i < signKeys.length; i++) {
      let shop = getShop(signKeys[i])
      if (shop) {
        shopOwners.push(shop.owner)
        if (shop.isServer) serverShop = true
      }
      brokenSignKeys.push(signKeys[i])
    }
  }

  if (player) {
    let pUuid = player.getStringUuid()
    let isAdmin = false
    try { isAdmin = player.hasPermissions(2) } catch(e) {}

    if (!isAdmin) {
      // A server shop still carries its creator as owner, but it is no longer
      // theirs to tear down.
      if (serverShop) {
        player.sendSystemMessage(Component.red("That is a server shop."))
        event.cancel()
        return
      }

      // A shop block is removable only by the player who owns every shop on it.
      let foreign = false
      for (let i = 0; i < shopOwners.length; i++) {
        if (shopOwners[i] !== pUuid) foreign = true
      }
      if (foreign) {
        player.sendSystemMessage(Component.red("That shop is not yours."))
        event.cancel()
        return
      }

      // Not a shop block, yet they hold a shop bypass: this is the stale-bypass
      // window right after looking away from a sign. Refuse the break and drop
      // the bypass now instead of waiting for the tick handler to catch up.
      if (shopOwners.length === 0 && playersWithBypass[pUuid]) {
        disableShopBypass(player)
        player.sendSystemMessage(Component.red("You cannot break blocks while using a shop."))
        event.cancel()
        return
      }
    }
  }

  // Allowed - drop the shop rows for whatever just went.
  for (let i = 0; i < brokenSignKeys.length; i++) {
    removeShop(event.server, brokenSignKeys[i])
    console.info("[KubeShop] Shop removed (" + (wasSign ? "sign" : "chest") + " broken by "
      + (player ? player.getName().getString() : "non-player") + ")")
    if (player) {
      player.sendSystemMessage(Component.gold(wasSign ? "Shop removed!" : "Shop removed (chest destroyed)!"))
    }
  }
})

// Helper function to deposit coins on right-click
function depositCoinOnClick(player, item, depositAll) {
  let server = player.getServer()
  let pUuid = player.getStringUuid()
  let denom = getCoinDenomFromStack(item)

  if (!denom) return false

  let countToDeposit = depositAll ? item.getCount() : 1
  let valueToDeposit = denom.value * countToDeposit

  addBalance(server, pUuid, valueToDeposit)
  item.shrink(countToDeposit)
  addHistoryEntry(server, pUuid, "deposit", valueToDeposit, null, countToDeposit + "x $" + denom.value + " coin" + (countToDeposit > 1 ? "s" : ""))

  let newBalance = getBalance(server, pUuid)
  player.sendSystemMessage(
    Component.empty()
      .append(Component.gold("Deposited "))
      .append(Component.green(formatBalance(valueToDeposit)))
      .append(Component.gray(" (" + countToDeposit + "x $" + denom.value + ")"))
      .append(Component.gold(" | Balance: "))
      .append(Component.green(formatBalance(newBalance)))
  )

  return true
}

// Coin right-click on block - prevent default interaction
BlockEvents.rightClicked(event => {
  let item = event.getItem()
  if (!item || item.isEmpty()) return

  let denom = getCoinDenomFromStack(item)
  if (!denom) return

  event.cancel()
})

// Coin right-click on air - deposit coin
ItemEvents.rightClicked(event => {
  let player = event.getEntity()
  let item = event.getItem()

  let denom = getCoinDenomFromStack(item)
  if (!denom) return

  let depositAll = player.isCrouching()

  depositCoinOnClick(player, item, depositAll)

  event.cancel()
})

// Main shop interaction handler
BlockEvents.rightClicked(event => {
  if (!isWallSign(event.block)) return

  let player = event.getEntity()
  let server = event.block.getLevel().getServer()

  let signKey = getBlockKey(event.block)
  let existingShop = getShop(signKey)
  let isCrouching = player.isCrouching()

  if (isCrouching) {
    if (existingShop) {
      let infoTemplate = JSON.parse(existingShop.itemTemplate)
      let infoItemNames = []
      for (let i = 0; i < infoTemplate.length; i++) {
        let itemId = infoTemplate[i].id
        let count = infoTemplate[i].count
        let simpleName = itemId.replace("minecraft:", "").replace(/_/g, " ")
        simpleName = simpleName.split(" ").map(function(word) {
          return word.charAt(0).toUpperCase() + word.slice(1)
        }).join(" ")
        infoItemNames.push(count + "x " + simpleName)
      }
      let infoItemsStr = infoItemNames.join(", ")

      let actionText = existingShop.type === "BUY" ? "selling" : "buying"

      player.sendSystemMessage(
        Component.empty()
          .append(Component.gold("Shop is " + actionText + " "))
          .append(Component.white(infoItemsStr))
          .append(Component.gold(" for "))
          .append(Component.green(existingShop.price + "$"))
      )
      event.cancel()
      return
    }

    let signData = parseSignText(event.block)
    if (!signData) return

    let attachedBlock = getAttachedBlock(event.block)
    if (!attachedBlock || !isContainer(attachedBlock)) {
      player.sendSystemMessage(Component.red("Sign must be placed on a container"))
      event.cancel()
      return
    }

    let chestKey = getBlockKey(attachedBlock)

    let itemTemplate = serializeInventory(attachedBlock)
    if (itemTemplate === "[]") {
      player.sendSystemMessage(Component.red("Put items in chest first"))
      event.cancel()
      return
    }

    let shopData = {
      owner: player.getStringUuid(),
      chestPos: chestKey,
      type: signData.type,
      price: signData.price,
      itemTemplate: itemTemplate
    }

    saveShop(server, signKey, shopData)
    updateSignForShop(event.block, signData.type, signData.price)

    let template = JSON.parse(itemTemplate)
    let itemNames = []
    for (let i = 0; i < template.length; i++) {
      let itemId = template[i].id
      let count = template[i].count
      let simpleName = itemId.replace("minecraft:", "").replace(/_/g, " ")
      simpleName = simpleName.split(" ").map(function(word) {
        return word.charAt(0).toUpperCase() + word.slice(1)
      }).join(" ")
      itemNames.push(count + "x " + simpleName)
    }
    let itemsStr = itemNames.join(", ")

    let actionText = signData.type === "BUY" ? "selling to users" : "buying from users"

    let msg = Component.empty()
      .append(Component.gold("Shop created! Shop is " + actionText + " "))
      .append(Component.white(itemsStr))
      .append(Component.gold(" for "))
      .append(Component.green(signData.price + "$"))

    player.sendSystemMessage(msg)
    event.cancel()
    return
  }

  // SHOP USAGE (not crouching)
  if (!existingShop) return

  if (!isSignWaxed(event.block)) return

  let chestPosStr = existingShop.chestPos
  let posParts = chestPosStr.split("_")
  let chestX = parseInt(posParts[0])
  let chestY = parseInt(posParts[1])
  let chestZ = parseInt(posParts[2])

  let level = event.block.getLevel()
  let chestBlock = level.getBlock(chestX, chestY, chestZ)

  if (!chestBlock || !isContainer(chestBlock)) {
    player.sendSystemMessage(Component.red("Shop chest not found"))
    return
  }

  let buyerUuid = player.getStringUuid()
  // A server shop pays into and out of the server wallet; the row keeps its
  // creator so the shop list and break protection still know who built it.
  let ownerUuid = existingShop.isServer ? SERVER_UUID : existingShop.owner
  let price = existingShop.price
  let itemTemplate = existingShop.itemTemplate

  if (existingShop.type === "BUY") {
    if (!hasBalance(server, buyerUuid, price)) {
      let buyerBal = getBalance(server, buyerUuid)
      let msg = Component.empty()
        .append(Component.red("You need "))
        .append(Component.yellow("$" + price))
        .append(Component.red(" but only have "))
        .append(Component.yellow("$" + buyerBal))
      player.sendSystemMessage(msg)
      event.cancel()
      return
    }

    let missingItems = getMissingItems(chestBlock.getInventory(), itemTemplate)
    if (missingItems.length > 0) {
      player.sendSystemMessage(Component.red("Shop is out of stock"))

      let ownerPlayer = server.getPlayer(ownerUuid)
      if (ownerPlayer) {
        let missingStr = missingItems.join(", ")
        ownerPlayer.sendSystemMessage(
          Component.empty()
            .append(Component.yellow(player.getName().getString()))
            .append(Component.red(" tried to buy from your shop but you're out of: "))
            .append(Component.white(missingStr))
        )
      }

      event.cancel()
      return
    }

    // Infinite: the chest is the stock list, not the stock - it never drains.
    if (!existingShop.isInfinite) removeItemsFromChest(chestBlock, itemTemplate)
    removeBalance(server, buyerUuid, price)
    giveItemsToPlayer(player, itemTemplate)
    addBalance(server, ownerUuid, price)

    let template = JSON.parse(itemTemplate)
    let itemNames = []
    for (let i = 0; i < template.length; i++) {
      let itemId = template[i].id
      let count = template[i].count
      let simpleName = itemId.replace("minecraft:", "").replace(/_/g, " ")
      simpleName = simpleName.split(" ").map(function(word) {
        return word.charAt(0).toUpperCase() + word.slice(1)
      }).join(" ")
      itemNames.push(count + "x " + simpleName)
    }
    let itemsStr = itemNames.join(", ")

    let ownerPlayer = server.getPlayer(ownerUuid)
    let ownerName = getPlayerNameByUuid(server, ownerUuid)

    addHistoryEntry(server, buyerUuid, "shop_buy", price, ownerName, itemsStr)
    addHistoryEntry(server, ownerUuid, "shop_sell", price, player.getName().getString(), itemsStr)

    player.sendSystemMessage(
      Component.empty()
        .append(Component.gold("Purchased "))
        .append(Component.white(itemsStr))
        .append(Component.gold(" for "))
        .append(Component.green(price + "$"))
    )

    if (ownerPlayer) {
      ownerPlayer.sendSystemMessage(
        Component.empty()
          .append(Component.yellow(player.getName().getString()))
          .append(Component.gold(" bought "))
          .append(Component.white(itemsStr))
          .append(Component.gold(" from your shop for "))
          .append(Component.green(price + "$"))
      )
    }

  } else {
    // SELL shop
    let missingPlayerItems = getMissingPlayerItems(player, itemTemplate)
    if (missingPlayerItems.length > 0) {
      let missingPlayerStr = missingPlayerItems.join(", ")
      player.sendSystemMessage(
        Component.empty()
          .append(Component.red("You're missing: "))
          .append(Component.white(missingPlayerStr))
      )
      event.cancel()
      return
    }

    if (!hasBalance(server, ownerUuid, price)) {
      player.sendSystemMessage(Component.red("Shop owner cannot afford this purchase"))

      let ownerPlayerBroke = server.getPlayer(ownerUuid)
      if (ownerPlayerBroke) {
        let brokeTemplate = JSON.parse(itemTemplate)
        let brokeItemNames = []
        for (let i = 0; i < brokeTemplate.length; i++) {
          let itemId = brokeTemplate[i].id
          let count = brokeTemplate[i].count
          let simpleName = itemId.replace("minecraft:", "").replace(/_/g, " ")
          simpleName = simpleName.split(" ").map(function(word) {
            return word.charAt(0).toUpperCase() + word.slice(1)
          }).join(" ")
          brokeItemNames.push(count + "x " + simpleName)
        }
        let brokeItemsStr = brokeItemNames.join(", ")
        ownerPlayerBroke.sendSystemMessage(
          Component.empty()
            .append(Component.yellow(player.getName().getString()))
            .append(Component.red(" tried to sell "))
            .append(Component.white(brokeItemsStr))
            .append(Component.red(" but you can't afford "))
            .append(Component.yellow(price + "$"))
        )
      }

      event.cancel()
      return
    }

    if (!existingShop.isInfinite && !chestHasSpace(chestBlock, itemTemplate)) {
      player.sendSystemMessage(Component.red("Shop chest is full"))

      let ownerPlayerFull = server.getPlayer(ownerUuid)
      if (ownerPlayerFull) {
        let fullTemplate = JSON.parse(itemTemplate)
        let fullItemNames = []
        for (let i = 0; i < fullTemplate.length; i++) {
          let itemId = fullTemplate[i].id
          let count = fullTemplate[i].count
          let simpleName = itemId.replace("minecraft:", "").replace(/_/g, " ")
          simpleName = simpleName.split(" ").map(function(word) {
            return word.charAt(0).toUpperCase() + word.slice(1)
          }).join(" ")
          fullItemNames.push(count + "x " + simpleName)
        }
        let fullItemsStr = fullItemNames.join(", ")
        ownerPlayerFull.sendSystemMessage(
          Component.empty()
            .append(Component.yellow(player.getName().getString()))
            .append(Component.red(" tried to sell "))
            .append(Component.white(fullItemsStr))
            .append(Component.red(" but your shop chest is full"))
        )
      }

      event.cancel()
      return
    }

    removeItemsFromPlayer(player, itemTemplate)
    // Infinite: the chest never fills up because it never receives anything.
    if (!existingShop.isInfinite) addItemsToChest(chestBlock, itemTemplate)
    removeBalance(server, ownerUuid, price)
    addBalance(server, buyerUuid, price)

    let sellTemplate = JSON.parse(itemTemplate)
    let sellItemNames = []
    for (let i = 0; i < sellTemplate.length; i++) {
      let itemId = sellTemplate[i].id
      let count = sellTemplate[i].count
      let simpleName = itemId.replace("minecraft:", "").replace(/_/g, " ")
      simpleName = simpleName.split(" ").map(function(word) {
        return word.charAt(0).toUpperCase() + word.slice(1)
      }).join(" ")
      sellItemNames.push(count + "x " + simpleName)
    }
    let sellItemsStr = sellItemNames.join(", ")

    let ownerPlayer = server.getPlayer(ownerUuid)
    let sellOwnerName = getPlayerNameByUuid(server, ownerUuid)

    addHistoryEntry(server, buyerUuid, "shop_sell", price, sellOwnerName, sellItemsStr)
    addHistoryEntry(server, ownerUuid, "shop_buy", price, player.getName().getString(), sellItemsStr)

    player.sendSystemMessage(
      Component.empty()
        .append(Component.gold("Sold "))
        .append(Component.white(sellItemsStr))
        .append(Component.gold(" for "))
        .append(Component.green(price + "$"))
    )

    if (ownerPlayer) {
      ownerPlayer.sendSystemMessage(
        Component.empty()
          .append(Component.yellow(player.getName().getString()))
          .append(Component.gold(" sold "))
          .append(Component.white(sellItemsStr))
          .append(Component.gold(" to your shop for "))
          .append(Component.green(price + "$"))
      )
    }
  }

  event.cancel()
})

// ============================================================================
// COMMANDS
// ============================================================================

function getPlayerNameByUuid(server, uuid) {
  if (uuid === SERVER_UUID) return 'Server'
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

// Shared by "/wallet admin plot add <price>" and the same command with a name:
// without a name the plot keeps the one it has, or gets the next number.
function adminAddPlot(ctx, price, explicitName) {
  let player = ctx.getSource().getPlayer()
  if (player == null) {
    ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
    return 0
  }

  if (price < 0) {
    ctx.getSource().sendFailure(Component.red("Price cannot be negative"))
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
    ctx.getSource().sendFailure(Component.red("Could not save the plot, check the server log"))
    return 0
  }

  ctx.getSource().sendSystemMessage(
    Component.empty()
      .append(Component.gold(existing ? "Updated " : "Put "))
      .append(Component.white(name))
      .append(Component.gold(existing ? " to " : " up for sale at "))
      .append(Component.green(formatBalance(price)))
      .append(Component.gray(" (chunk " + pos.cx + ", " + pos.cz + " in " + dimIdOf(pos.dim) + ")"))
  )

  if (existing && existing.owner) {
    ctx.getSource().sendSystemMessage(
      Component.yellow("Note: this plot is already owned by ")
        .append(Component.aqua(getPlayerNameByUuid(ctx.getSource().getServer(), existing.owner)))
    )
  }

  return 1
}

// [S] server-owned, [I] infinite stock, [SI] both - the tag the admin shop
// list puts after [BUY]/[SELL].
function shopFlagComponent(shop) {
  let tag = (shop.isServer ? "S" : "") + (shop.isInfinite ? "I" : "")
  return tag ? Component.gold("[" + tag + "] ") : Component.empty()
}

// Shared by "/wallet admin shop convert-to-server" and "convert-to-infinite".
// Both toggle, so the same command undoes itself - there is no separate revert.
function adminToggleShopFlag(ctx, flag) {
  let player = ctx.getSource().getPlayer()
  if (player == null) {
    ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
    return 0
  }

  let looking = getShopSignPlayerIsLookingAt(player)
  let shop = looking ? getShop(looking.signKey) : null
  if (!shop) {
    ctx.getSource().sendFailure(Component.red("Look at a shop sign first"))
    return 0
  }

  let isServer = flag === "server" ? !shop.isServer : shop.isServer
  let isInfinite = flag === "infinite" ? !shop.isInfinite : shop.isInfinite

  if (!setShopFlags(ctx.getSource().getServer(), looking.signKey, isServer, isInfinite)) {
    ctx.getSource().sendFailure(Component.red("Could not update that shop"))
    return 0
  }

  ctx.getSource().sendSystemMessage(
    Component.gold("Shop is now ")
      .append(Component.yellow(isServer ? "server-owned" : "owned by " + getPlayerNameByUuid(ctx.getSource().getServer(), shop.owner)))
      .append(Component.gold(", "))
      .append(Component.yellow(isInfinite ? "infinite stock" : "normal stock"))
  )
  return 1
}

// Shared by "/wallet admin balance <player>" and its older "getbalance" name.
// GAME_PROFILE only suggests online names, but resolves offline ones through the
// server profile cache, so any player who has joined before can be looked up.
function adminShowBalance(ctx) {
  let profiles = Arguments.GAME_PROFILE.getResult(ctx, "player")

  let profileArray = profiles.toArray()
  if (profileArray.length === 0) {
    ctx.getSource().sendFailure(Component.red("No player found"))
    return 0
  }

  let srv = ctx.getSource().getServer()
  let prof = profileArray[0]
  let pUuid = prof.getId().toString()
  let pName = prof.getName()

  let bal = getBalance(srv, pUuid)

  let msg = Component.empty()
    .append(Component.yellow(pName))
    .append(Component.gold("'s balance: "))
    .append(Component.green(formatBalance(bal)))

  ctx.getSource().sendSystemMessage(msg)
  return 1
}

ServerEvents.commandRegistry(event => {
  let Commands = event.getCommands()
  let Arguments = event.getArguments()

  event.register(
    Commands.literal("wallet")
      .requires(src => {
        if (!databaseAvailable) {
          src.sendFailure(Component.red('[KubeShop] Database configuration is not loaded. Economy features are disabled.'))
          return false
        }
        return true
      })
      .executes(ctx => {
        let src = ctx.getSource()
        src.sendSystemMessage(Component.gold("=== Wallet Commands ==="))
        src.sendSystemMessage(Component.yellow("/wallet balance").append(Component.gray(" - Check your balance")))
        src.sendSystemMessage(Component.yellow("/wallet pay <player> <amount>").append(Component.gray(" - Send money")))
        src.sendSystemMessage(Component.yellow("/wallet withdraw <amount>").append(Component.gray(" - Withdraw as coins (auto-split)")))
        src.sendSystemMessage(Component.yellow("/wallet withdraw <amount> <denom>").append(Component.gray(" - Withdraw as specific coin (1/10/100/1000)")))
        src.sendSystemMessage(Component.yellow("/wallet deposit").append(Component.gray(" - Deposit all coins")))
        src.sendSystemMessage(Component.yellow("/wallet deposit <amount>").append(Component.gray(" - Deposit specific value")))
        src.sendSystemMessage(Component.yellow("/wallet history").append(Component.gray(" - Transaction history")))
        src.sendSystemMessage(Component.yellow("/wallet shop help").append(Component.gray(" - Shop creation guide")))
        src.sendSystemMessage(Component.yellow("/wallet plot").append(Component.gray(" - The plot you stand in")))
        src.sendSystemMessage(Component.yellow("/wallet plot list").append(Component.gray(" - Plots for sale")))
        if (src.hasPermission(2)) {
          src.sendSystemMessage(Component.red("/wallet admin").append(Component.gray(" - Admin commands")))
        }
        return 1
      })

      .then(Commands.literal("balance")
        .executes(ctx => {
          let player = ctx.getSource().getPlayer()
          if (player == null) {
            ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
            return 0
          }

          let srv = ctx.getSource().getServer()
          let pUuid = player.getStringUuid()
          let bal = getBalance(srv, pUuid)

          player.sendSystemMessage(
            Component.empty()
              .append(Component.gold("Your balance: "))
              .append(Component.green(formatBalance(bal)))
          )

          return 1
        })
      )

      .then(Commands.literal("help")
        .executes(ctx => {
          let src = ctx.getSource()
          src.sendSystemMessage(Component.gold("=== Wallet Commands ==="))
          src.sendSystemMessage(Component.yellow("/wallet balance").append(Component.gray(" - Check your balance")))
          src.sendSystemMessage(Component.yellow("/wallet pay <player> <amount>").append(Component.gray(" - Send money")))
          src.sendSystemMessage(Component.gold("--- Coin Commands ---"))
          src.sendSystemMessage(Component.yellow("/wallet withdraw <amount>").append(Component.gray(" - Withdraw as coins (auto-split)")))
          src.sendSystemMessage(Component.yellow("/wallet withdraw <amount> <denom>").append(Component.gray(" - Withdraw as specific coin")))
          src.sendSystemMessage(Component.gray("  Denominations: 1, 10, 100, 1000, 10000"))
          src.sendSystemMessage(Component.gray("  Example: /wallet withdraw 100 10 = 10x $10 coins"))
          src.sendSystemMessage(Component.yellow("/wallet deposit").append(Component.gray(" - Deposit all coins in inventory")))
          src.sendSystemMessage(Component.yellow("/wallet deposit <amount>").append(Component.gray(" - Deposit specific value from coins")))
          src.sendSystemMessage(Component.gold("--- Other ---"))
          src.sendSystemMessage(Component.yellow("/wallet history").append(Component.gray(" - Transaction history")))
          src.sendSystemMessage(Component.yellow("/wallet shop help").append(Component.gray(" - Shop creation guide")))
          src.sendSystemMessage(Component.gold("--- Plots ---"))
          src.sendSystemMessage(Component.yellow("/wallet plot").append(Component.gray(" - Name, price and owner of the plot you stand in")))
          src.sendSystemMessage(Component.yellow("/wallet plot buy").append(Component.gray(" - Buy that plot, it is claimed for you")))
          src.sendSystemMessage(Component.yellow("/wallet plot sell <price>").append(Component.gray(" - List your own plot at your price")))
          src.sendSystemMessage(Component.yellow("/wallet plot unsell").append(Component.gray(" - Take your plot off the market")))
          src.sendSystemMessage(Component.yellow("/wallet plot list").append(Component.gray(" - Plots for sale")))
          if (src.hasPermission(2)) {
            src.sendSystemMessage(Component.red("/wallet admin").append(Component.gray(" - Admin commands")))
          }
          return 1
        })
      )

      .then(Commands.literal("shop")
        .executes(ctx => {
          let src = ctx.getSource()
          src.sendSystemMessage(Component.gold("=== Shop Commands ==="))
          src.sendSystemMessage(Component.yellow("/wallet shop help").append(Component.gray(" - Shop creation guide")))
          return 1
        })

        .then(Commands.literal("help")
          .executes(ctx => {
            let src = ctx.getSource()
            src.sendSystemMessage(Component.gold("=== Shop Creation Guide ==="))
            src.sendSystemMessage(Component.white("1. Place a chest with items to sell/buy"))
            src.sendSystemMessage(Component.white("2. Place a wall sign on the chest"))
            src.sendSystemMessage(Component.white("3. Write on the sign:"))
            src.sendSystemMessage(Component.gray("   Line 1: ").append(Component.yellow("[BUY]")).append(Component.gray(" or ")).append(Component.yellow("[SELL]")))
            src.sendSystemMessage(Component.gray("   Line 2-3: Description (optional)"))
            src.sendSystemMessage(Component.gray("   Line 4: Price (e.g. ").append(Component.green("10")).append(Component.gray(")")))
            src.sendSystemMessage(Component.white("4. Shift+right-click the sign to create"))
            src.sendSystemMessage(Component.gold("---"))
            src.sendSystemMessage(Component.yellow("[BUY]").append(Component.gray(" = Players buy FROM the shop")))
            src.sendSystemMessage(Component.yellow("[SELL]").append(Component.gray(" = Players sell TO the shop")))
            src.sendSystemMessage(Component.gray("Right-click shop sign to buy/sell"))
            src.sendSystemMessage(Component.gray("Shift+click existing shop to see info"))
            src.sendSystemMessage(Component.gray("Break sign or chest to remove shop"))
            return 1
          })
        )
      )

      .then(Commands.literal("pay")
        .then(
          Commands.argument("recipient", Arguments.GAME_PROFILE.create(event))
            .then(
              Commands.argument("amount", Arguments.INTEGER.create(event))
                .executes(ctx => {
                  let sender = ctx.getSource().getPlayer()
                  if (sender == null) {
                    ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
                    return 0
                  }

                  let payAmount = Arguments.INTEGER.getResult(ctx, "amount")
                  if (payAmount <= 0) {
                    ctx.getSource().sendFailure(Component.red("Amount must be positive"))
                    return 0
                  }

                  let recipientProfiles = Arguments.GAME_PROFILE.getResult(ctx, "recipient")
                  let recipientArray = recipientProfiles.toArray()
                  if (recipientArray.length === 0) {
                    ctx.getSource().sendFailure(Component.red("No player found"))
                    return 0
                  }

                  let payServer = ctx.getSource().getServer()
                  let senderUuid = sender.getStringUuid()
                  let recipientProfile = recipientArray[0]
                  let recipientUuid = recipientProfile.getId().toString()
                  let recipientName = recipientProfile.getName()

                  if (senderUuid === recipientUuid) {
                    ctx.getSource().sendFailure(Component.red("You cannot pay yourself"))
                    return 0
                  }

                  let senderBalance = getBalance(payServer, senderUuid)
                  if (senderBalance < payAmount) {
                    let failMsg = Component.empty()
                      .append(Component.red("Insufficient funds. You have "))
                      .append(Component.yellow(formatBalance(senderBalance)))
                    ctx.getSource().sendFailure(failMsg)
                    return 0
                  }

                  removeBalance(payServer, senderUuid, payAmount)
                  addBalance(payServer, recipientUuid, payAmount)

                  addHistoryEntry(payServer, senderUuid, "pay_sent", payAmount, recipientName, null)
                  addHistoryEntry(payServer, recipientUuid, "pay_received", payAmount, sender.getName().getString(), null)

                  let successMsg = Component.empty()
                    .append(Component.gold("Sent "))
                    .append(Component.green(formatBalance(payAmount)))
                    .append(Component.gold(" to "))
                    .append(Component.yellow(recipientName))

                  sender.sendSystemMessage(successMsg)

                  let onlineRecipient = payServer.getPlayer(recipientUuid)
                  if (onlineRecipient != null) {
                    let receivedMsg = Component.empty()
                      .append(Component.gold("You received "))
                      .append(Component.green(formatBalance(payAmount)))
                      .append(Component.gold(" from "))
                      .append(Component.yellow(sender.getName().getString()))
                    onlineRecipient.sendSystemMessage(receivedMsg)
                  }

                  return 1
                })
            )
        )
      )

      .then(Commands.literal("history")
        .executes(ctx => {
          let player = ctx.getSource().getPlayer()
          if (player == null) {
            ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
            return 0
          }

          let srv = ctx.getSource().getServer()
          let pUuid = player.getStringUuid()
          let history = getHistory(srv, pUuid)

          ctx.getSource().sendSystemMessage(Component.gold("=== Transaction History ==="))

          if (history.length === 0) {
            ctx.getSource().sendSystemMessage(Component.gray("No transactions yet"))
            return 1
          }

          let toShow = Math.min(history.length, 10)
          for (let i = 0; i < toShow; i++) {
            let entry = history[i]
            let timeStr = formatTimestamp(entry.time)
            let msg = Component.empty().append(Component.gray("[" + timeStr + "] "))

            if (entry.type === "pay_sent") {
              msg.append(Component.red("-" + formatBalance(entry.amount)))
                .append(Component.gray(" sent to "))
                .append(Component.yellow(entry.other))
            } else if (entry.type === "pay_received") {
              msg.append(Component.green("+" + formatBalance(entry.amount)))
                .append(Component.gray(" from "))
                .append(Component.yellow(entry.other))
            } else if (entry.type === "shop_buy") {
              msg.append(Component.red("-" + formatBalance(entry.amount)))
                .append(Component.gray(" bought "))
                .append(Component.white(entry.desc || "items"))
                .append(Component.gray(" from "))
                .append(Component.yellow(entry.other || "Unknown"))
            } else if (entry.type === "shop_sell") {
              msg.append(Component.green("+" + formatBalance(entry.amount)))
                .append(Component.gray(" sold "))
                .append(Component.white(entry.desc || "items"))
                .append(Component.gray(" to "))
                .append(Component.yellow(entry.other || "Unknown"))
            } else if (entry.type === "admin_set") {
              msg.append(Component.aqua(formatBalance(entry.amount)))
                .append(Component.gray(" balance set by admin"))
            } else if (entry.type === "admin_add") {
              msg.append(Component.green("+" + formatBalance(entry.amount)))
                .append(Component.gray(" added by admin"))
            } else if (entry.type === "admin_subtract") {
              msg.append(Component.red("-" + formatBalance(entry.amount)))
                .append(Component.gray(" removed by admin"))
            } else if (entry.type === "withdraw") {
              msg.append(Component.red("-" + formatBalance(entry.amount)))
                .append(Component.gray(" withdrawn as coins"))
                .append(entry.desc ? Component.gray(" (" + entry.desc + ")") : Component.empty())
            } else if (entry.type === "deposit") {
              msg.append(Component.green("+" + formatBalance(entry.amount)))
                .append(Component.gray(" deposited from coins"))
            } else if (entry.type === "plot_buy") {
              msg.append(Component.red("-" + formatBalance(entry.amount)))
                .append(Component.gray(" bought "))
                .append(Component.white(entry.desc || "a plot"))
              if (entry.other) msg.append(Component.gray(" from ")).append(Component.yellow(entry.other))
            } else if (entry.type === "plot_sell") {
              msg.append(Component.green("+" + formatBalance(entry.amount)))
                .append(Component.gray(" sold "))
                .append(Component.white(entry.desc || "a plot"))
                .append(Component.gray(" to "))
                .append(Component.yellow(entry.other || "Unknown"))
            }

            ctx.getSource().sendSystemMessage(msg)
          }

          if (history.length > 10) {
            ctx.getSource().sendSystemMessage(Component.gray("... and " + (history.length - 10) + " more"))
          }

          return 1
        })
      )

      .then(Commands.literal("withdraw")
        .then(
          Commands.argument("amount", Arguments.INTEGER.create(event))
            .executes(ctx => {
              let player = ctx.getSource().getPlayer()
              if (player == null) {
                ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
                return 0
              }

              let withdrawAmount = Arguments.INTEGER.getResult(ctx, "amount")
              if (withdrawAmount <= 0) {
                ctx.getSource().sendFailure(Component.red("Amount must be positive"))
                return 0
              }

              let srv = ctx.getSource().getServer()
              let pUuid = player.getStringUuid()
              let currentBalance = getBalance(srv, pUuid)

              if (currentBalance < withdrawAmount) {
                ctx.getSource().sendFailure(
                  Component.empty()
                    .append(Component.red("Insufficient balance. You have "))
                    .append(Component.yellow(formatBalance(currentBalance)))
                )
                return 0
              }

              removeBalance(srv, pUuid, withdrawAmount)
              giveCoinsEfficient(player, withdrawAmount)

              addHistoryEntry(srv, pUuid, "withdraw", withdrawAmount, null, "Coins withdrawn")

              let remaining = withdrawAmount
              let parts = []
              for (let i = 0; i < COIN_DENOMINATIONS.length; i++) {
                let denom = COIN_DENOMINATIONS[i]
                if (remaining >= denom.value) {
                  let count = Math.floor(remaining / denom.value)
                  remaining = remaining % denom.value
                  parts.push(count + "x $" + denom.value)
                }
              }

              player.sendSystemMessage(
                Component.empty()
                  .append(Component.gold("Withdrew "))
                  .append(Component.green(formatBalance(withdrawAmount)))
                  .append(Component.gold(" as coins: "))
                  .append(Component.yellow(parts.join(", ")))
              )

              return 1
            })
            .then(
              Commands.argument("denomination", Arguments.INTEGER.create(event))
                .executes(ctx => {
                  let player = ctx.getSource().getPlayer()
                  if (player == null) {
                    ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
                    return 0
                  }

                  let withdrawAmount = Arguments.INTEGER.getResult(ctx, "amount")
                  let denomination = Arguments.INTEGER.getResult(ctx, "denomination")

                  if (withdrawAmount <= 0) {
                    ctx.getSource().sendFailure(Component.red("Amount must be positive"))
                    return 0
                  }

                  let validDenom = false
                  for (let i = 0; i < COIN_DENOMINATIONS.length; i++) {
                    if (COIN_DENOMINATIONS[i].value === denomination) {
                      validDenom = true
                      break
                    }
                  }
                  if (!validDenom) {
                    ctx.getSource().sendFailure(Component.red("Invalid denomination. Use 1, 10, 100, 1000, or 10000"))
                    return 0
                  }

                  if (withdrawAmount % denomination !== 0) {
                    ctx.getSource().sendFailure(
                      Component.empty()
                        .append(Component.red("Amount "))
                        .append(Component.yellow(formatBalance(withdrawAmount)))
                        .append(Component.red(" is not divisible by "))
                        .append(Component.yellow("$" + denomination))
                    )
                    return 0
                  }

                  let srv = ctx.getSource().getServer()
                  let pUuid = player.getStringUuid()
                  let currentBalance = getBalance(srv, pUuid)

                  if (currentBalance < withdrawAmount) {
                    ctx.getSource().sendFailure(
                      Component.empty()
                        .append(Component.red("Insufficient balance. You have "))
                        .append(Component.yellow(formatBalance(currentBalance)))
                    )
                    return 0
                  }

                  removeBalance(srv, pUuid, withdrawAmount)
                  giveCoinsSpecific(player, withdrawAmount, denomination)

                  let coinCount = withdrawAmount / denomination
                  addHistoryEntry(srv, pUuid, "withdraw", withdrawAmount, null, coinCount + "x $" + denomination + " coins")

                  player.sendSystemMessage(
                    Component.empty()
                      .append(Component.gold("Withdrew "))
                      .append(Component.green(formatBalance(withdrawAmount)))
                      .append(Component.gold(" as "))
                      .append(Component.yellow(coinCount + "x $" + denomination + " coins"))
                  )

                  return 1
                })
            )
        )
      )

      .then(Commands.literal("deposit")
        .executes(ctx => {
          let player = ctx.getSource().getPlayer()
          if (player == null) {
            ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
            return 0
          }

          let srv = ctx.getSource().getServer()
          let pUuid = player.getStringUuid()

          let coinInfo = countPlayerCoins(player)
          if (coinInfo.total <= 0) {
            ctx.getSource().sendFailure(Component.red("You don't have any coins to deposit"))
            return 0
          }

          removeCoinsFromPlayer(player, coinInfo.total)
          addBalance(srv, pUuid, coinInfo.total)

          addHistoryEntry(srv, pUuid, "deposit", coinInfo.total, null, "All coins deposited")

          player.sendSystemMessage(
            Component.empty()
              .append(Component.gold("Deposited "))
              .append(Component.green(formatBalance(coinInfo.total)))
              .append(Component.gold(" from coins"))
          )

          return 1
        })
        .then(
          Commands.argument("amount", Arguments.INTEGER.create(event))
            .executes(ctx => {
              let player = ctx.getSource().getPlayer()
              if (player == null) {
                ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
                return 0
              }

              let depositAmount = Arguments.INTEGER.getResult(ctx, "amount")
              if (depositAmount <= 0) {
                ctx.getSource().sendFailure(Component.red("Amount must be positive"))
                return 0
              }

              let srv = ctx.getSource().getServer()
              let pUuid = player.getStringUuid()

              let coinInfo = countPlayerCoins(player)
              if (coinInfo.total < depositAmount) {
                ctx.getSource().sendFailure(
                  Component.empty()
                    .append(Component.red("You don't have enough coins. You have "))
                    .append(Component.yellow(formatBalance(coinInfo.total)))
                    .append(Component.red(" in coins"))
                )
                return 0
              }

              if (!canPayExactWithCoins(player, depositAmount)) {
                ctx.getSource().sendFailure(
                  Component.empty()
                    .append(Component.red("Cannot deposit exact amount "))
                    .append(Component.yellow(formatBalance(depositAmount)))
                    .append(Component.red(". You need exact change."))
                )
                return 0
              }

              removeCoinsFromPlayer(player, depositAmount)
              addBalance(srv, pUuid, depositAmount)

              addHistoryEntry(srv, pUuid, "deposit", depositAmount, null, "Coins deposited")

              player.sendSystemMessage(
                Component.empty()
                  .append(Component.gold("Deposited "))
                  .append(Component.green(formatBalance(depositAmount)))
                  .append(Component.gold(" from coins"))
              )

              return 1
            })
        )
      )

      .then(Commands.literal("plot")
        .executes(ctx => {
          let player = ctx.getSource().getPlayer()
          if (player == null) {
            ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
            return 0
          }

          let pos = getPlayerPlot(player)
          let plot = getPlot(pos.key)

          if (!plot) {
            player.sendSystemMessage(Component.red("You are not standing on a plot"))
            player.sendSystemMessage(Component.gray("See ").append(Component.yellow("/wallet plot list")).append(Component.gray(" for plots you can buy")))
            return 1
          }

          let label = plotLabel(plot)

          if (plot.owner && plot.salePrice === null) {
            let ownerName = plot.owner === player.getStringUuid()
              ? "you"
              : getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)
            player.sendSystemMessage(
              Component.empty()
                .append(Component.gold(label + " is owned by "))
                .append(Component.aqua(ownerName))
            )
            if (plot.owner === player.getStringUuid()) {
              player.sendSystemMessage(
                Component.gray("Sell it with ").append(Component.yellow("/wallet plot sell <price>"))
              )
            }
            return 1
          }

          if (plot.owner === player.getStringUuid()) {
            player.sendSystemMessage(
              Component.empty()
                .append(Component.gold(label + " is yours, listed for "))
                .append(Component.green(formatBalance(plot.salePrice)))
            )
            player.sendSystemMessage(
              Component.gray("Take it off the market with ").append(Component.yellow("/wallet plot unsell"))
            )
            return 1
          }

          let price = plot.owner ? plot.salePrice : plot.price
          let msg = Component.empty().append(Component.gold(label + " is for sale for "))
            .append(Component.green(formatBalance(price)))
          if (plot.owner) {
            msg.append(Component.gold(" by "))
              .append(Component.aqua(getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)))
          }
          player.sendSystemMessage(msg)
          player.sendSystemMessage(
            Component.green("[BUY]")
              .clickRunCommand("/wallet plot buy")
              .hover(Component.gray("Buy " + label + " for " + formatBalance(price)))
          )
          return 1
        })

        .then(Commands.literal("buy")
          .executes(ctx => {
            let player = ctx.getSource().getPlayer()
            if (player == null) {
              ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
              return 0
            }

            let srv = ctx.getSource().getServer()
            let pUuid = player.getStringUuid()
            let pos = getPlayerPlot(player)
            let plot = getPlot(pos.key)

            if (!plot) {
              ctx.getSource().sendFailure(Component.red("You are not standing on a plot"))
              return 0
            }

            let label = plotLabel(plot)

            if (plot.owner === pUuid) {
              ctx.getSource().sendFailure(Component.red("You already own " + label))
              return 0
            }

            // Owned plots are only buyable while their owner lists them for resale.
            if (plot.owner && plot.salePrice === null) {
              ctx.getSource().sendFailure(
                Component.empty()
                  .append(Component.red(label + " is already owned by "))
                  .append(Component.yellow(getPlayerNameByUuid(srv, plot.owner)))
              )
              return 0
            }

            let seller = plot.owner
            let sellerName = seller ? getPlayerNameByUuid(srv, seller) : null
            let price = seller ? plot.salePrice : plot.price

            // Refuse before taking money if somebody outside this sale holds the
            // chunk. Only a server claim (an admin holding the plot) or the
            // seller's own claim gets released.
            let claimState = getChunkClaimState(player, seller)
            if (claimState.claimed && !claimState.mine && !claimState.server && !claimState.otherMember) {
              ctx.getSource().sendFailure(
                Component.empty()
                  .append(Component.red(label + " is claimed by "))
                  .append(Component.yellow(claimState.ownerName))
                  .append(Component.red(" - tell an admin"))
              )
              return 0
            }

            let balance = getBalance(srv, pUuid)
            if (balance < price) {
              ctx.getSource().sendFailure(
                Component.empty()
                  .append(Component.red("You need "))
                  .append(Component.yellow(formatBalance(price)))
                  .append(Component.red(" but only have "))
                  .append(Component.yellow(formatBalance(balance)))
              )
              return 0
            }

            let taken = seller
              ? transferPlot(pos.key, seller, pUuid, price)
              : takePlot(pos.key, pUuid)
            if (!taken) {
              ctx.getSource().sendFailure(Component.red("Somebody just bought " + label))
              return 0
            }

            if (!removeBalance(srv, pUuid, price)) {
              if (seller) {
                restoreListing(pos.key, seller, price)
              } else {
                releasePlot(pos.key)
              }
              ctx.getSource().sendFailure(Component.red("Could not take the money from your wallet, purchase cancelled"))
              return 0
            }

            addHistoryEntry(srv, pUuid, "plot_buy", price, sellerName, label)

            if (seller) {
              addBalance(srv, seller, price)
              addHistoryEntry(srv, seller, "plot_sell", price, player.getName().getString(), label)

              let sellerPlayer = srv.getPlayer(seller)
              if (sellerPlayer) {
                sellerPlayer.sendSystemMessage(
                  Component.empty()
                    .append(Component.yellow(player.getName().getString()))
                    .append(Component.gold(" bought your "))
                    .append(Component.white(label))
                    .append(Component.gold(" for "))
                    .append(Component.green(formatBalance(price)))
                )
              }
            }

            player.sendSystemMessage(
              Component.empty()
                .append(Component.gold("Bought "))
                .append(Component.white(label))
                .append(sellerName ? Component.gold(" from ") : Component.empty())
                .append(sellerName ? Component.aqua(sellerName) : Component.empty())
                .append(Component.gold(" for "))
                .append(Component.green(formatBalance(price)))
                .append(Component.gold(" | Balance: "))
                .append(Component.green(formatBalance(getBalance(srv, pUuid))))
            )

            let claimed = claimChunkFor(player, pUuid)
            if (claimed.ok) {
              player.sendSystemMessage(Component.gray("The plot is now claimed for you"))
            } else {
              player.sendSystemMessage(
                Component.yellow("Could not claim it for you (" + claimed.msg + ") - claim this chunk yourself with /claim")
              )
            }

            return 1
          })
        )

        .then(Commands.literal("sell")
          .then(
            Commands.argument("price", Arguments.INTEGER.create(event))
              .executes(ctx => {
                let player = ctx.getSource().getPlayer()
                if (player == null) {
                  ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
                  return 0
                }

                let price = Arguments.INTEGER.getResult(ctx, "price")
                if (price < 0) {
                  ctx.getSource().sendFailure(Component.red("Price cannot be negative"))
                  return 0
                }

                let pos = getPlayerPlot(player)
                let plot = getPlot(pos.key)
                if (!plot || plot.owner !== player.getStringUuid()) {
                  ctx.getSource().sendFailure(Component.red("You do not own the plot you are standing on"))
                  return 0
                }

                if (!setPlotSalePrice(pos.key, player.getStringUuid(), price)) {
                  ctx.getSource().sendFailure(Component.red("Could not list the plot, try again"))
                  return 0
                }

                player.sendSystemMessage(
                  Component.empty()
                    .append(Component.gold("Listed "))
                    .append(Component.white(plotLabel(plot)))
                    .append(Component.gold(" for "))
                    .append(Component.green(formatBalance(price)))
                    .append(Component.gray(" - anyone standing on it can buy it now"))
                )
                return 1
              })
          )
        )

        .then(Commands.literal("unsell")
          .executes(ctx => {
            let player = ctx.getSource().getPlayer()
            if (player == null) {
              ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
              return 0
            }

            let pos = getPlayerPlot(player)
            let plot = getPlot(pos.key)
            if (!plot || plot.owner !== player.getStringUuid()) {
              ctx.getSource().sendFailure(Component.red("You do not own the plot you are standing on"))
              return 0
            }

            if (plot.salePrice === null) {
              ctx.getSource().sendFailure(Component.red(plotLabel(plot) + " is not listed for sale"))
              return 0
            }

            setPlotSalePrice(pos.key, player.getStringUuid(), null)
            player.sendSystemMessage(
              Component.gold("Took ").append(Component.white(plotLabel(plot))).append(Component.gold(" off the market"))
            )
            return 1
          })
        )

        .then(Commands.literal("list")
          .executes(ctx => {
            let plots = getAllPlots()
            ctx.getSource().sendSystemMessage(Component.gold("=== Plots For Sale ==="))

            let count = 0
            for (let i = 0; i < plots.length; i++) {
              let plot = plots[i]
              if (plot.owner && plot.salePrice === null) continue
              count++

              let row = Component.empty()
                .append(Component.white(plotLabel(plot)))
                .append(Component.gray(" - "))
                .append(Component.green(formatBalance(plot.owner ? plot.salePrice : plot.price)))
              if (plot.owner) {
                row.append(Component.gray(" by "))
                  .append(Component.aqua(getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)))
              }
              ctx.getSource().sendSystemMessage(row)
            }

            if (count === 0) {
              ctx.getSource().sendSystemMessage(Component.gray("No plots for sale right now"))
            } else {
              ctx.getSource().sendSystemMessage(
                Component.gray("Total: " + count + " - stand on one and run ")
                  .append(Component.yellow("/wallet plot buy"))
              )
            }
            return 1
          })
        )
      )

      .then(Commands.literal("admin")
        .requires(src => src.hasPermission(2))

        .executes(ctx => {
          let src = ctx.getSource()
          src.sendSystemMessage(Component.gold("=== Wallet Admin Commands ==="))
          src.sendSystemMessage(Component.yellow("/wallet admin balance <player>").append(Component.gray(" - Check any player's balance, online or not")))
          src.sendSystemMessage(Component.yellow("/wallet admin setbalance <player> <amount>").append(Component.gray(" - Set balance")))
          src.sendSystemMessage(Component.yellow("/wallet admin addbalance <player> <amount>").append(Component.gray(" - Add to balance")))
          src.sendSystemMessage(Component.yellow("/wallet admin subtractbalance <player> <amount>").append(Component.gray(" - Subtract from balance")))
          src.sendSystemMessage(Component.yellow("/wallet admin history <player>").append(Component.gray(" - View player's history")))
          src.sendSystemMessage(Component.yellow("/wallet admin shop list [player]").append(Component.gray(" - List shops, [S]erver / [I]nfinite")))
          src.sendSystemMessage(Component.yellow("/wallet admin shop convert-to-server").append(Component.gray(" - Toggle the shop you look at between server- and player-owned")))
          src.sendSystemMessage(Component.yellow("/wallet admin shop convert-to-infinite").append(Component.gray(" - Toggle infinite stock on the shop you look at")))
          src.sendSystemMessage(Component.yellow("/wallet admin shop server-balance [amount]").append(Component.gray(" - Show or set the server wallet")))
          src.sendSystemMessage(Component.yellow("/wallet admin plot add <price> [name]").append(Component.gray(" - Sell the plot you stand in, [name] renames it")))
          src.sendSystemMessage(Component.yellow("/wallet admin plot rename <name>").append(Component.gray(" - Rename the plot you stand in")))
          src.sendSystemMessage(Component.yellow("/wallet admin plot claim_as <player>").append(Component.gray(" - Give that plot to a player for free")))
          src.sendSystemMessage(Component.yellow("/wallet admin plot reclaim").append(Component.gray(" - Take that plot back from its owner, back on sale")))
          src.sendSystemMessage(Component.yellow("/wallet admin plot remove").append(Component.gray(" - Take that plot off the market")))
          src.sendSystemMessage(Component.yellow("/wallet admin plot list").append(Component.gray(" - List plots and owners")))
          return 1
        })

        .then(Commands.literal("balance")
          .then(
            Commands.argument("player", Arguments.GAME_PROFILE.create(event))
              .executes(ctx => adminShowBalance(ctx))
          )
        )

        .then(Commands.literal("getbalance")
          .then(
            Commands.argument("player", Arguments.GAME_PROFILE.create(event))
              .executes(ctx => adminShowBalance(ctx))
          )
        )

        .then(Commands.literal("setbalance")
          .then(
            Commands.argument("player", Arguments.GAME_PROFILE.create(event))
              .then(
                Commands.argument("amount", Arguments.INTEGER.create(event))
                  .executes(ctx => {
                    let profiles = Arguments.GAME_PROFILE.getResult(ctx, "player")
                    let amt = Arguments.INTEGER.getResult(ctx, "amount")

                    if (amt < 0) {
                      ctx.getSource().sendFailure(Component.red("Amount cannot be negative"))
                      return 0
                    }

                    let profileArray = profiles.toArray()
                    if (profileArray.length === 0) {
                      ctx.getSource().sendFailure(Component.red("No player found"))
                      return 0
                    }

                    let srv = ctx.getSource().getServer()
                    let prof = profileArray[0]
                    let pUuid = prof.getId().toString()
                    let pName = prof.getName()

                    let oldBal = getBalance(srv, pUuid)
                    setBalance(srv, pUuid, amt)

                    addHistoryEntry(srv, pUuid, "admin_set", amt, "Admin", "Balance set from " + formatBalance(oldBal))

                    let msg = Component.empty()
                      .append(Component.gold("Set "))
                      .append(Component.yellow(pName))
                      .append(Component.gold("'s balance to "))
                      .append(Component.green(formatBalance(amt)))

                    ctx.getSource().sendSystemMessage(msg)
                    return 1
                  })
              )
          )
        )

        .then(Commands.literal("addbalance")
          .then(
            Commands.argument("player", Arguments.GAME_PROFILE.create(event))
              .then(
                Commands.argument("amount", Arguments.INTEGER.create(event))
                  .executes(ctx => {
                    let profiles = Arguments.GAME_PROFILE.getResult(ctx, "player")
                    let amt = Arguments.INTEGER.getResult(ctx, "amount")

                    if (amt <= 0) {
                      ctx.getSource().sendFailure(Component.red("Amount must be positive"))
                      return 0
                    }

                    let profileArray = profiles.toArray()
                    if (profileArray.length === 0) {
                      ctx.getSource().sendFailure(Component.red("No player found"))
                      return 0
                    }

                    let srv = ctx.getSource().getServer()
                    let prof = profileArray[0]
                    let pUuid = prof.getId().toString()
                    let pName = prof.getName()

                    let oldBal = getBalance(srv, pUuid)
                    addBalance(srv, pUuid, amt)
                    let newBal = getBalance(srv, pUuid)

                    addHistoryEntry(srv, pUuid, "admin_add", amt, "Admin", null)

                    let msg = Component.empty()
                      .append(Component.gold("Added "))
                      .append(Component.green(formatBalance(amt)))
                      .append(Component.gold(" to "))
                      .append(Component.yellow(pName))
                      .append(Component.gold("'s balance ("))
                      .append(Component.gray(formatBalance(oldBal)))
                      .append(Component.gold(" -> "))
                      .append(Component.green(formatBalance(newBal)))
                      .append(Component.gold(")"))

                    ctx.getSource().sendSystemMessage(msg)
                    return 1
                  })
              )
          )
        )

        .then(Commands.literal("subtractbalance")
          .then(
            Commands.argument("player", Arguments.GAME_PROFILE.create(event))
              .then(
                Commands.argument("amount", Arguments.INTEGER.create(event))
                  .executes(ctx => {
                    let profiles = Arguments.GAME_PROFILE.getResult(ctx, "player")
                    let amt = Arguments.INTEGER.getResult(ctx, "amount")

                    if (amt <= 0) {
                      ctx.getSource().sendFailure(Component.red("Amount must be positive"))
                      return 0
                    }

                    let profileArray = profiles.toArray()
                    if (profileArray.length === 0) {
                      ctx.getSource().sendFailure(Component.red("No player found"))
                      return 0
                    }

                    let srv = ctx.getSource().getServer()
                    let prof = profileArray[0]
                    let pUuid = prof.getId().toString()
                    let pName = prof.getName()

                    let oldBal = getBalance(srv, pUuid)
                    if (oldBal < amt) {
                      ctx.getSource().sendFailure(
                        Component.empty()
                          .append(Component.red("Cannot subtract "))
                          .append(Component.yellow(formatBalance(amt)))
                          .append(Component.red(" from "))
                          .append(Component.yellow(pName))
                          .append(Component.red(" (has "))
                          .append(Component.yellow(formatBalance(oldBal)))
                          .append(Component.red(")"))
                      )
                      return 0
                    }

                    removeBalance(srv, pUuid, amt)
                    let newBal = getBalance(srv, pUuid)

                    addHistoryEntry(srv, pUuid, "admin_subtract", amt, "Admin", null)

                    let msg = Component.empty()
                      .append(Component.gold("Subtracted "))
                      .append(Component.red(formatBalance(amt)))
                      .append(Component.gold(" from "))
                      .append(Component.yellow(pName))
                      .append(Component.gold("'s balance ("))
                      .append(Component.gray(formatBalance(oldBal)))
                      .append(Component.gold(" -> "))
                      .append(Component.green(formatBalance(newBal)))
                      .append(Component.gold(")"))

                    ctx.getSource().sendSystemMessage(msg)
                    return 1
                  })
              )
          )
        )

        .then(Commands.literal("history")
          .then(
            Commands.argument("player", Arguments.GAME_PROFILE.create(event))
              .executes(ctx => {
                let profiles = Arguments.GAME_PROFILE.getResult(ctx, "player")

                let profileArray = profiles.toArray()
                if (profileArray.length === 0) {
                  ctx.getSource().sendFailure(Component.red("No player found"))
                  return 0
                }

                let srv = ctx.getSource().getServer()
                let prof = profileArray[0]
                let pUuid = prof.getId().toString()
                let pName = prof.getName()
                let history = getHistory(srv, pUuid)

                ctx.getSource().sendSystemMessage(
                  Component.gold("=== Transaction History for ")
                    .append(Component.yellow(pName))
                    .append(Component.gold(" ==="))
                )

                if (history.length === 0) {
                  ctx.getSource().sendSystemMessage(Component.gray("No transactions yet"))
                  return 1
                }

                let toShow = Math.min(history.length, 15)
                for (let i = 0; i < toShow; i++) {
                  let entry = history[i]
                  let timeStr = formatTimestamp(entry.time)
                  let msg = Component.empty().append(Component.gray("[" + timeStr + "] "))

                  if (entry.type === "pay_sent") {
                    msg.append(Component.red("-" + formatBalance(entry.amount)))
                      .append(Component.gray(" sent to "))
                      .append(Component.yellow(entry.other))
                  } else if (entry.type === "pay_received") {
                    msg.append(Component.green("+" + formatBalance(entry.amount)))
                      .append(Component.gray(" from "))
                      .append(Component.yellow(entry.other))
                  } else if (entry.type === "shop_buy") {
                    msg.append(Component.red("-" + formatBalance(entry.amount)))
                      .append(Component.gray(" bought "))
                      .append(Component.white(entry.desc || "items"))
                      .append(Component.gray(" from "))
                      .append(Component.yellow(entry.other || "Unknown"))
                  } else if (entry.type === "shop_sell") {
                    msg.append(Component.green("+" + formatBalance(entry.amount)))
                      .append(Component.gray(" sold "))
                      .append(Component.white(entry.desc || "items"))
                      .append(Component.gray(" to "))
                      .append(Component.yellow(entry.other || "Unknown"))
                  } else if (entry.type === "admin_set") {
                    msg.append(Component.aqua(formatBalance(entry.amount)))
                      .append(Component.gray(" balance set by admin"))
                  } else if (entry.type === "admin_add") {
                    msg.append(Component.green("+" + formatBalance(entry.amount)))
                      .append(Component.gray(" added by admin"))
                  } else if (entry.type === "admin_subtract") {
                    msg.append(Component.red("-" + formatBalance(entry.amount)))
                      .append(Component.gray(" removed by admin"))
                  } else if (entry.type === "plot_buy") {
                    msg.append(Component.red("-" + formatBalance(entry.amount)))
                      .append(Component.gray(" bought "))
                      .append(Component.white(entry.desc || "a plot"))
                    if (entry.other) msg.append(Component.gray(" from ")).append(Component.yellow(entry.other))
                  } else if (entry.type === "plot_sell") {
                    msg.append(Component.green("+" + formatBalance(entry.amount)))
                      .append(Component.gray(" sold "))
                      .append(Component.white(entry.desc || "a plot"))
                      .append(Component.gray(" to "))
                      .append(Component.yellow(entry.other || "Unknown"))
                  }

                  ctx.getSource().sendSystemMessage(msg)
                }

                if (history.length > 15) {
                  ctx.getSource().sendSystemMessage(Component.gray("... and " + (history.length - 15) + " more"))
                }

                return 1
              })
          )
        )

        .then(Commands.literal("plot")
          .then(Commands.literal("add")
            .then(
              Commands.argument("price", Arguments.INTEGER.create(event))
                .executes(ctx => adminAddPlot(ctx, Arguments.INTEGER.getResult(ctx, "price"), null))
                .then(
                  Commands.argument("name", Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => adminAddPlot(
                      ctx,
                      Arguments.INTEGER.getResult(ctx, "price"),
                      Arguments.GREEDY_STRING.getResult(ctx, "name")
                    ))
                )
            )
          )

          .then(Commands.literal("rename")
            .then(
              Commands.argument("name", Arguments.GREEDY_STRING.create(event))
                .executes(ctx => {
                  let player = ctx.getSource().getPlayer()
                  if (player == null) {
                    ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
                    return 0
                  }

                  let pos = getPlayerPlot(player)
                  let plot = getPlot(pos.key)
                  if (!plot) {
                    ctx.getSource().sendFailure(Component.red("You are not standing on a plot"))
                    return 0
                  }

                  let name = validPlotName(ctx.getSource(), Arguments.GREEDY_STRING.getResult(ctx, "name"))
                  if (!name) return 0

                  // Same write as "plot add" - the price and the owner stay put.
                  if (!savePlot(pos, plot.price, name)) {
                    ctx.getSource().sendFailure(Component.red("Could not rename the plot, check the server log"))
                    return 0
                  }

                  ctx.getSource().sendSystemMessage(
                    Component.empty()
                      .append(Component.white(plotLabel(plot)))
                      .append(Component.gold(" renamed to "))
                      .append(Component.white(name))
                  )
                  return 1
                })
            )
          )

          .then(Commands.literal("claim_as")
            .then(
              Commands.argument("player", Arguments.GAME_PROFILE.create(event))
                .executes(ctx => {
                  let admin = ctx.getSource().getPlayer()
                  if (admin == null) {
                    ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
                    return 0
                  }

                  let profileArray = Arguments.GAME_PROFILE.getResult(ctx, "player").toArray()
                  if (profileArray.length === 0) {
                    ctx.getSource().sendFailure(Component.red("No player found"))
                    return 0
                  }

                  let srv = ctx.getSource().getServer()
                  let prof = profileArray[0]
                  let targetUuid = prof.getId().toString()
                  let targetName = prof.getName()

                  let pos = getPlayerPlot(admin)
                  let plot = getPlot(pos.key)
                  if (!plot) {
                    ctx.getSource().sendFailure(Component.red("You are not standing on a plot"))
                    return 0
                  }

                  let label = plotLabel(plot)

                  if (plot.owner === targetUuid) {
                    ctx.getSource().sendFailure(
                      Component.empty()
                        .append(Component.yellow(targetName))
                        .append(Component.red(" already owns " + label))
                    )
                    return 0
                  }

                  // Handing a plot straight from one player to another would take
                  // it away with no warning - reclaim it first, deliberately.
                  if (plot.owner) {
                    ctx.getSource().sendFailure(
                      Component.empty()
                        .append(Component.red(label + " is owned by "))
                        .append(Component.yellow(getPlayerNameByUuid(srv, plot.owner)))
                        .append(Component.red(" - run "))
                        .append(Component.yellow("/wallet admin plot reclaim"))
                        .append(Component.red(" first"))
                    )
                    return 0
                  }

                  if (!takePlot(pos.key, targetUuid)) {
                    ctx.getSource().sendFailure(Component.red("Somebody just bought " + label))
                    return 0
                  }

                  addHistoryEntry(srv, targetUuid, "plot_buy", 0, "Admin", label)

                  ctx.getSource().sendSystemMessage(
                    Component.empty()
                      .append(Component.gold("Gave "))
                      .append(Component.white(label))
                      .append(Component.gold(" to "))
                      .append(Component.aqua(targetName))
                      .append(Component.gray(" (chunk " + pos.cx + ", " + pos.cz + ")"))
                  )

                  // OPAC claims by UUID, so this works whether or not they are online.
                  let claimed = claimChunkFor(admin, targetUuid)
                  if (claimed.ok) {
                    ctx.getSource().sendSystemMessage(Component.gray("The plot is now claimed for " + targetName))
                  } else {
                    ctx.getSource().sendSystemMessage(
                      Component.yellow("Could not claim it for them (" + claimed.msg + ") - they can claim it themselves with /claim")
                    )
                  }

                  let targetPlayer = srv.getPlayer(targetUuid)
                  if (targetPlayer) {
                    targetPlayer.sendSystemMessage(
                      Component.empty()
                        .append(Component.gold("An admin gave you "))
                        .append(Component.white(label))
                    )
                  }

                  return 1
                })
            )
          )

          .then(Commands.literal("reclaim")
            .executes(ctx => {
              let player = ctx.getSource().getPlayer()
              if (player == null) {
                ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
                return 0
              }

              let pos = getPlayerPlot(player)
              let plot = getPlot(pos.key)
              if (!plot) {
                ctx.getSource().sendFailure(Component.red("You are not standing on a plot"))
                return 0
              }

              let previousOwner = plot.owner
                ? getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)
                : null

              releasePlot(pos.key)
              let unclaimed = unclaimChunkAt(player)

              let msg = Component.empty()
                .append(Component.white(plotLabel(plot)))
                .append(Component.gold(previousOwner ? " taken back from " : " released"))
              if (previousOwner) msg.append(Component.aqua(previousOwner))
              msg.append(Component.gold(" - back on sale for "))
                .append(Component.green(formatBalance(plot.price)))
              ctx.getSource().sendSystemMessage(msg)

              if (!unclaimed.ok) {
                ctx.getSource().sendSystemMessage(
                  Component.yellow("Could not drop the claim (" + unclaimed.msg + ") - unclaim it yourself")
                )
              }

              return 1
            })
          )

          .then(Commands.literal("remove")
            .executes(ctx => {
              let player = ctx.getSource().getPlayer()
              if (player == null) {
                ctx.getSource().sendFailure(Component.red("This command can only be used by players"))
                return 0
              }

              let pos = getPlayerPlot(player)
              let plot = getPlot(pos.key)
              if (!plot) {
                ctx.getSource().sendFailure(Component.red("You are not standing on a plot"))
                return 0
              }

              deletePlot(pos.key)

              let msg = Component.empty()
                .append(Component.gold("Removed "))
                .append(Component.white(plotLabel(plot)))
                .append(Component.gray(" (chunk " + pos.cx + ", " + pos.cz + ")"))
              if (plot.owner) {
                msg.append(Component.gray(" (was owned by "))
                  .append(Component.aqua(getPlayerNameByUuid(ctx.getSource().getServer(), plot.owner)))
                  .append(Component.gray(", their claim is untouched)"))
              }
              ctx.getSource().sendSystemMessage(msg)
              return 1
            })
          )

          .then(Commands.literal("list")
            .executes(ctx => {
              let srv = ctx.getSource().getServer()
              let plots = getAllPlots()

              ctx.getSource().sendSystemMessage(Component.gold("=== All Plots ==="))

              if (plots.length === 0) {
                ctx.getSource().sendSystemMessage(Component.gray("No plots registered"))
                return 1
              }

              for (let i = 0; i < plots.length; i++) {
                let plot = plots[i]
                let x = plot.cx * 16 + 8
                let z = plot.cz * 16 + 8

                let tpLink = Component.lightPurple("[TP]")
                  .clickRunCommand("/execute in " + dimIdOf(plot.dim) + " run tp @s " + x + " ~ " + z)
                  .hover(Component.gray("Click to teleport to " + x + ", " + z))

                let status = plot.owner
                  ? Component.aqua(getPlayerNameByUuid(srv, plot.owner))
                  : Component.green("FOR SALE")

                let row = Component.empty()
                  .append(Component.white(plotLabel(plot)))
                  .append(Component.gray(" (" + plot.cx + ", " + plot.cz + ") - "))
                  .append(Component.green(formatBalance(plot.price)))
                  .append(Component.gray(" - "))
                  .append(status)
                if (plot.salePrice !== null) {
                  row.append(Component.gray(", listed for "))
                    .append(Component.green(formatBalance(plot.salePrice)))
                }
                ctx.getSource().sendSystemMessage(row.append(Component.gray(" ")).append(tpLink))
              }

              ctx.getSource().sendSystemMessage(Component.gray("Total: " + plots.length + " plots"))
              return 1
            })
          )
        )

        .then(Commands.literal("shop")
          .then(Commands.literal("list")
            .executes(ctx => {
              let srv = ctx.getSource().getServer()
              let shops = getAllShops()

              ctx.getSource().sendSystemMessage(Component.gold("=== All Shops ==="))

              let shopKeys = Object.keys(shops)
              if (shopKeys.length === 0) {
                ctx.getSource().sendSystemMessage(Component.gray("No shops registered"))
                return 1
              }

              for (let i = 0; i < shopKeys.length; i++) {
                let signKey = shopKeys[i]
                let shop = shops[signKey]

                let posParts = signKey.split("_")
                let x = posParts[0]
                let y = posParts[1]
                let z = posParts[2]

                let ownerName = shop.isServer ? "Server" : getPlayerNameByUuid(srv, shop.owner)

                let template = JSON.parse(shop.itemTemplate)
                let itemNames = []
                for (let j = 0; j < template.length; j++) {
                  let itemId = template[j].id
                  let simpleName = itemId.replace("minecraft:", "").replace(/_/g, " ")
                  simpleName = simpleName.split(" ").map(function(word) {
                    return word.charAt(0).toUpperCase() + word.slice(1)
                  }).join(" ")
                  itemNames.push(simpleName)
                }
                let itemsStr = itemNames.join(", ")
                if (itemsStr.length > 30) {
                  itemsStr = itemsStr.substring(0, 27) + "..."
                }

                let tpCmd = "/tp @s " + x + " " + y + " " + z

                let tpLink = Component.lightPurple("[TP]")
                  .clickRunCommand(tpCmd)
                  .hover(Component.gray("Click to teleport to " + x + ", " + y + ", " + z))

                let shopMsg = Component.empty()
                  .append(Component.yellow("[" + shop.type + "] "))
                  .append(shopFlagComponent(shop))
                  .append(Component.white(itemsStr))
                  .append(Component.gray(" - "))
                  .append(Component.green(shop.price + "$"))
                  .append(Component.gray(" by "))
                  .append(Component.aqua(ownerName))
                  .append(Component.gray(" "))
                  .append(tpLink)

                ctx.getSource().sendSystemMessage(shopMsg)
              }

              ctx.getSource().sendSystemMessage(Component.gray("Total: " + shopKeys.length + " shops"))
              return 1
            })
            .then(
              Commands.argument("player", Arguments.GAME_PROFILE.create(event))
                .executes(ctx => {
                  let profiles = Arguments.GAME_PROFILE.getResult(ctx, "player")

                  let profileArray = profiles.toArray()
                  if (profileArray.length === 0) {
                    ctx.getSource().sendFailure(Component.red("No player found"))
                    return 0
                  }

                  let srv = ctx.getSource().getServer()
                  let shops = getAllShops()

                  let prof = profileArray[0]
                  let pUuid = prof.getId().toString()
                  let pName = prof.getName()

                  ctx.getSource().sendSystemMessage(
                    Component.gold("=== Shops owned by ")
                      .append(Component.yellow(pName))
                      .append(Component.gold(" ==="))
                  )

                  let count = 0
                  for (let signKey in shops) {
                    let shop = shops[signKey]
                    if (shop.owner !== pUuid) continue
                    count++

                    let posParts = signKey.split("_")
                    let x = posParts[0]
                    let y = posParts[1]
                    let z = posParts[2]

                    let template = JSON.parse(shop.itemTemplate)
                    let itemNames = []
                    for (let j = 0; j < template.length; j++) {
                      let itemId = template[j].id
                      let simpleName = itemId.replace("minecraft:", "").replace(/_/g, " ")
                      simpleName = simpleName.split(" ").map(function(word) {
                        return word.charAt(0).toUpperCase() + word.slice(1)
                      }).join(" ")
                      itemNames.push(simpleName)
                    }
                    let itemsStr = itemNames.join(", ")
                    if (itemsStr.length > 30) {
                      itemsStr = itemsStr.substring(0, 27) + "..."
                    }

                    let tpCmd = "/tp @s " + x + " " + y + " " + z

                    let tpLink = Component.lightPurple("[TP]")
                      .clickRunCommand(tpCmd)
                      .hover(Component.gray("Click to teleport to " + x + ", " + y + ", " + z))

                    let shopMsg = Component.empty()
                      .append(Component.yellow("[" + shop.type + "] "))
                      .append(shopFlagComponent(shop))
                      .append(Component.white(itemsStr))
                      .append(Component.gray(" - "))
                      .append(Component.green(shop.price + "$"))
                      .append(Component.gray(" "))
                      .append(tpLink)

                    ctx.getSource().sendSystemMessage(shopMsg)
                  }

                  if (count === 0) {
                    ctx.getSource().sendSystemMessage(Component.gray("No shops found for this player"))
                  } else {
                    ctx.getSource().sendSystemMessage(Component.gray("Total: " + count + " shops"))
                  }

                  return 1
                })
            )
          )

          .then(Commands.literal("convert-to-server")
            .executes(ctx => adminToggleShopFlag(ctx, "server"))
          )

          .then(Commands.literal("convert-to-infinite")
            .executes(ctx => adminToggleShopFlag(ctx, "infinite"))
          )

          // A server SELL shop pays players out of the server wallet, so that
          // wallet needs a way to be filled - no player profile resolves to it.
          .then(Commands.literal("server-balance")
            .executes(ctx => {
              let src = ctx.getSource()
              src.sendSystemMessage(
                Component.gold("Server balance: ")
                  .append(Component.green(formatBalance(getBalance(src.getServer(), SERVER_UUID))))
              )
              return 1
            })
            .then(
              Commands.argument("amount", Arguments.INTEGER.create(event))
                .executes(ctx => {
                  let src = ctx.getSource()
                  let amount = Arguments.INTEGER.getResult(ctx, "amount")
                  if (amount < 0) {
                    src.sendFailure(Component.red("Amount cannot be negative"))
                    return 0
                  }
                  setBalance(src.getServer(), SERVER_UUID, amount)
                  src.sendSystemMessage(
                    Component.gold("Server balance set to ")
                      .append(Component.green(formatBalance(amount)))
                  )
                  return 1
                })
            )
          )
        )
      )
  )

})

console.info("[KubeShop] Economy & Shop system loaded (MySQL version)")

})()
