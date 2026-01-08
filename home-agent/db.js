/**
 * SQLite database layer for storing historical metrics
 * Stores 30 days of metrics data for trend analysis
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Data directory for SQLite file
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'metrics.db');

// Retention periods in milliseconds
const RETENTION = {
  metrics: 30 * 24 * 60 * 60 * 1000,      // 30 days
  cpu_cores: 30 * 24 * 60 * 60 * 1000,    // 30 days
  disk_io: 30 * 24 * 60 * 60 * 1000,      // 30 days
  network_stats: 30 * 24 * 60 * 60 * 1000, // 30 days
  container_stats: 7 * 24 * 60 * 60 * 1000, // 7 days
  gpu_stats: 30 * 24 * 60 * 60 * 1000,    // 30 days
  service_health: 7 * 24 * 60 * 60 * 1000, // 7 days
  top_processes: 7 * 24 * 60 * 60 * 1000, // 7 days
  alerts: 90 * 24 * 60 * 60 * 1000,       // 90 days
  hourly_summary: 365 * 24 * 60 * 60 * 1000 // 1 year
};

// Discord webhook configuration
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || null;
let lastDiscordAlert = {};
const DISCORD_COOLDOWN = 5 * 60 * 1000; // 5 minutes between same alert type

let db = null;

/**
 * Initialize database with schema
 */
function initialize() {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL'); // Better concurrent access
  db.pragma('synchronous = NORMAL'); // Good balance of safety/performance

  // Create tables
  db.exec(`
    -- Core metrics table (sampled every 10 seconds)
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      cpu_usage REAL,
      cpu_iowait REAL,
      cpu_steal REAL,
      cpu_irq REAL,
      cpu_user REAL,
      cpu_system REAL,
      cpu_temperature REAL,
      memory_usage REAL,
      memory_used INTEGER,
      memory_available INTEGER,
      swap_usage REAL,
      swap_used INTEGER,
      context_switch_rate REAL,
      interrupt_rate REAL,
      procs_running INTEGER,
      procs_blocked INTEGER,
      load_1m REAL,
      load_5m REAL,
      load_15m REAL
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);

    -- Per-core CPU (sampled every 10 seconds)
    CREATE TABLE IF NOT EXISTS cpu_cores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      core_id INTEGER NOT NULL,
      usage REAL,
      user_pct REAL,
      system_pct REAL,
      iowait_pct REAL,
      steal_pct REAL,
      irq_pct REAL
    );

    CREATE INDEX IF NOT EXISTS idx_cpu_cores_timestamp ON cpu_cores(timestamp);

    -- Disk I/O (sampled every 10 seconds)
    CREATE TABLE IF NOT EXISTS disk_io (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      device TEXT NOT NULL,
      read_iops REAL,
      write_iops REAL,
      read_bytes_sec REAL,
      write_bytes_sec REAL,
      avg_latency_ms REAL,
      queue_depth REAL,
      utilization REAL
    );

    CREATE INDEX IF NOT EXISTS idx_disk_io_timestamp ON disk_io(timestamp);

    -- Top processes (sampled every 60 seconds)
    CREATE TABLE IF NOT EXISTS top_processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      pid INTEGER,
      username TEXT,
      cpu REAL,
      memory REAL,
      rss INTEGER,
      command TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_top_processes_timestamp ON top_processes(timestamp);

    -- Alerts/anomalies detected
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT,
      details TEXT,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
    CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved_at);

    -- Aggregated hourly summaries
    CREATE TABLE IF NOT EXISTS hourly_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hour_timestamp INTEGER NOT NULL UNIQUE,
      cpu_avg REAL,
      cpu_max REAL,
      cpu_p95 REAL,
      iowait_avg REAL,
      iowait_max REAL,
      memory_avg REAL,
      memory_max REAL,
      swap_avg REAL,
      swap_max REAL,
      context_switches_avg REAL,
      interrupts_avg REAL,
      max_core_usage REAL,
      max_core_id INTEGER,
      sample_count INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_hourly_hour ON hourly_summary(hour_timestamp);

    -- Network bandwidth stats
    CREATE TABLE IF NOT EXISTS network_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      interface TEXT NOT NULL,
      rx_bytes_sec REAL,
      tx_bytes_sec REAL,
      rx_packets_sec REAL,
      tx_packets_sec REAL,
      rx_errors INTEGER,
      tx_errors INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_network_timestamp ON network_stats(timestamp);

    -- Container stats history
    CREATE TABLE IF NOT EXISTS container_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      name TEXT NOT NULL,
      cpu REAL,
      mem_percent REAL,
      net_rx INTEGER,
      net_tx INTEGER,
      block_read INTEGER,
      block_write INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_container_timestamp ON container_stats(timestamp);

    -- GPU stats history
    CREATE TABLE IF NOT EXISTS gpu_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      gpu_index INTEGER,
      name TEXT,
      usage REAL,
      memory_usage REAL,
      temperature REAL,
      power_draw REAL
    );

    CREATE INDEX IF NOT EXISTS idx_gpu_timestamp ON gpu_stats(timestamp);

    -- Service health checks
    CREATE TABLE IF NOT EXISTS service_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT,
      status TEXT,
      status_code INTEGER,
      response_time INTEGER,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_service_health_timestamp ON service_health(timestamp);
  `);

  console.log('Database initialized at', DB_PATH);
  return db;
}

/**
 * Insert current metrics snapshot
 */
function insertMetrics(metrics) {
  if (!db) return;

  const timestamp = Date.now();

  // Insert main metrics
  const insertMain = db.prepare(`
    INSERT INTO metrics (
      timestamp, cpu_usage, cpu_iowait, cpu_steal, cpu_irq, cpu_user, cpu_system,
      cpu_temperature, memory_usage, memory_used, memory_available,
      swap_usage, swap_used, context_switch_rate, interrupt_rate,
      procs_running, procs_blocked, load_1m, load_5m, load_15m
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const ext = metrics.cpuExtended || {};
  const mem = metrics.memoryPressure || {};
  const kern = metrics.kernelStats || {};
  const load = metrics.loadAverage || {};
  const temp = metrics.cpuTemperature;

  insertMain.run(
    timestamp,
    ext.user + ext.system || null,
    ext.iowait || null,
    ext.steal || null,
    ext.irq || null,
    ext.user || null,
    ext.system || null,
    temp ? temp.celsius : null,
    metrics.memory ? metrics.memory.usage : null,
    metrics.memory ? metrics.memory.used : null,
    mem.available || null,
    mem.swapUsage || null,
    mem.swapUsed || null,
    kern.contextSwitchRate || null,
    kern.interruptRate || null,
    kern.procsRunning || null,
    kern.procsBlocked || null,
    load['1m'] || null,
    load['5m'] || null,
    load['15m'] || null
  );

  // Insert per-core CPU data
  if (metrics.perCoreCpu && metrics.perCoreCpu.length > 0) {
    const insertCore = db.prepare(`
      INSERT INTO cpu_cores (timestamp, core_id, usage, user_pct, system_pct, iowait_pct, steal_pct, irq_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const core of metrics.perCoreCpu) {
      insertCore.run(timestamp, core.core, core.usage, core.user, core.system, core.iowait, core.steal, core.irq);
    }
  }

  // Insert disk I/O data
  if (metrics.diskIo && metrics.diskIo.length > 0) {
    const insertDisk = db.prepare(`
      INSERT INTO disk_io (timestamp, device, read_iops, write_iops, read_bytes_sec, write_bytes_sec, avg_latency_ms, queue_depth, utilization)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const disk of metrics.diskIo) {
      insertDisk.run(timestamp, disk.device, disk.readIops, disk.writeIops, disk.readBytesPerSec, disk.writeBytesPerSec, disk.avgLatencyMs, disk.queueDepth, disk.utilization);
    }
  }
}

/**
 * Insert top processes (called less frequently - every 60s)
 */
function insertTopProcesses(processes) {
  if (!db || !processes) return;

  const timestamp = Date.now();
  const insert = db.prepare(`
    INSERT INTO top_processes (timestamp, pid, username, cpu, memory, rss, command)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const proc of processes) {
    insert.run(timestamp, proc.pid, proc.user, proc.cpu, proc.memory, proc.rss, proc.command);
  }
}

/**
 * Insert or update an alert
 */
function insertAlert(alert) {
  if (!db) return null;

  // Check if similar unresolved alert exists
  const existing = db.prepare(`
    SELECT id FROM alerts WHERE type = ? AND resolved_at IS NULL
  `).get(alert.type);

  if (existing) {
    // Update existing alert
    db.prepare(`
      UPDATE alerts SET message = ?, details = ?, severity = ? WHERE id = ?
    `).run(alert.message, JSON.stringify(alert), alert.severity, existing.id);
    return existing.id;
  }

  // Insert new alert
  const result = db.prepare(`
    INSERT INTO alerts (timestamp, type, severity, message, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), alert.type, alert.severity, alert.message, JSON.stringify(alert));

  return result.lastInsertRowid;
}

/**
 * Resolve an alert
 */
function resolveAlert(alertId) {
  if (!db) return;
  db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ?').run(Date.now(), alertId);
}

/**
 * Auto-resolve alerts that are no longer active
 */
function autoResolveAlerts(currentBottlenecks) {
  if (!db) return;

  const activeTypes = new Set(currentBottlenecks.map(b => b.type));
  const unresolvedAlerts = db.prepare('SELECT id, type FROM alerts WHERE resolved_at IS NULL').all();

  for (const alert of unresolvedAlerts) {
    if (!activeTypes.has(alert.type)) {
      resolveAlert(alert.id);
    }
  }
}

/**
 * Get active and recent alerts
 */
function getAlerts(limit = 50) {
  if (!db) return { active: [], recent: [] };

  const active = db.prepare(`
    SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY timestamp DESC
  `).all();

  const recent = db.prepare(`
    SELECT * FROM alerts WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?
  `).all(limit);

  return {
    active: active.map(a => ({ ...a, details: JSON.parse(a.details || '{}') })),
    recent: recent.map(a => ({ ...a, details: JSON.parse(a.details || '{}') }))
  };
}

/**
 * Query historical metrics
 */
function queryMetrics(start, end, resolution = 'raw') {
  if (!db) return [];

  let query;
  if (resolution === 'raw') {
    query = db.prepare(`
      SELECT * FROM metrics WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC
    `);
  } else if (resolution === 'minute') {
    query = db.prepare(`
      SELECT
        (timestamp / 60000) * 60000 as timestamp,
        AVG(cpu_usage) as cpu_usage,
        AVG(cpu_iowait) as cpu_iowait,
        MAX(cpu_temperature) as cpu_temperature,
        AVG(memory_usage) as memory_usage,
        AVG(swap_usage) as swap_usage,
        AVG(context_switch_rate) as context_switch_rate
      FROM metrics
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY timestamp / 60000
      ORDER BY timestamp ASC
    `);
  } else if (resolution === 'hour') {
    query = db.prepare(`
      SELECT * FROM hourly_summary WHERE hour_timestamp >= ? AND hour_timestamp <= ? ORDER BY hour_timestamp ASC
    `);
  }

  return query.all(start, end);
}

/**
 * Query per-core CPU history
 */
function queryCpuCores(start, end, coreId = null) {
  if (!db) return [];

  if (coreId !== null) {
    return db.prepare(`
      SELECT * FROM cpu_cores WHERE timestamp >= ? AND timestamp <= ? AND core_id = ? ORDER BY timestamp ASC
    `).all(start, end, coreId);
  }

  return db.prepare(`
    SELECT * FROM cpu_cores WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC, core_id ASC
  `).all(start, end);
}

/**
 * Query disk I/O history
 */
function queryDiskIo(start, end, device = null) {
  if (!db) return [];

  if (device) {
    return db.prepare(`
      SELECT * FROM disk_io WHERE timestamp >= ? AND timestamp <= ? AND device = ? ORDER BY timestamp ASC
    `).all(start, end, device);
  }

  return db.prepare(`
    SELECT * FROM disk_io WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC
  `).all(start, end);
}

/**
 * Query top processes history
 */
function queryTopProcesses(start, end) {
  if (!db) return [];

  return db.prepare(`
    SELECT * FROM top_processes WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC, cpu DESC
  `).all(start, end);
}

/**
 * Create hourly summary aggregation
 */
function aggregateHourly() {
  if (!db) return;

  const now = Date.now();
  const hourAgo = now - 3600000;
  const hourStart = Math.floor(hourAgo / 3600000) * 3600000;

  // Check if already aggregated
  const existing = db.prepare('SELECT 1 FROM hourly_summary WHERE hour_timestamp = ?').get(hourStart);
  if (existing) return;

  const stats = db.prepare(`
    SELECT
      AVG(cpu_usage) as cpu_avg,
      MAX(cpu_usage) as cpu_max,
      AVG(cpu_iowait) as iowait_avg,
      MAX(cpu_iowait) as iowait_max,
      AVG(memory_usage) as memory_avg,
      MAX(memory_usage) as memory_max,
      AVG(swap_usage) as swap_avg,
      MAX(swap_usage) as swap_max,
      AVG(context_switch_rate) as context_switches_avg,
      AVG(interrupt_rate) as interrupts_avg,
      COUNT(*) as sample_count
    FROM metrics
    WHERE timestamp >= ? AND timestamp < ?
  `).get(hourStart, hourStart + 3600000);

  const maxCore = db.prepare(`
    SELECT core_id, MAX(usage) as max_usage
    FROM cpu_cores
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY core_id
    ORDER BY max_usage DESC
    LIMIT 1
  `).get(hourStart, hourStart + 3600000);

  if (stats && stats.sample_count > 0) {
    db.prepare(`
      INSERT INTO hourly_summary (
        hour_timestamp, cpu_avg, cpu_max, iowait_avg, iowait_max,
        memory_avg, memory_max, swap_avg, swap_max,
        context_switches_avg, interrupts_avg, max_core_usage, max_core_id, sample_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      hourStart,
      stats.cpu_avg, stats.cpu_max,
      stats.iowait_avg, stats.iowait_max,
      stats.memory_avg, stats.memory_max,
      stats.swap_avg, stats.swap_max,
      stats.context_switches_avg, stats.interrupts_avg,
      maxCore?.max_usage, maxCore?.core_id,
      stats.sample_count
    );
  }
}

/**
 * Clean up old data based on retention policies
 */
function cleanup() {
  if (!db) return;

  const now = Date.now();

  for (const [table, retention] of Object.entries(RETENTION)) {
    const cutoff = now - retention;
    const columnName = table === 'hourly_summary' ? 'hour_timestamp' : 'timestamp';
    db.prepare(`DELETE FROM ${table} WHERE ${columnName} < ?`).run(cutoff);
  }

  // Vacuum occasionally to reclaim space (every ~100 cleanups, roughly daily)
  if (Math.random() < 0.01) {
    db.exec('VACUUM');
  }
}

/**
 * Get database statistics
 */
function getDbStats() {
  if (!db) return null;

  const counts = {};
  for (const table of ['metrics', 'cpu_cores', 'disk_io', 'top_processes', 'alerts', 'hourly_summary']) {
    const result = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
    counts[table] = result.count;
  }

  const fileStats = fs.statSync(DB_PATH);

  return {
    path: DB_PATH,
    sizeBytes: fileStats.size,
    sizeMB: Math.round(fileStats.size / 1024 / 1024 * 10) / 10,
    tableCounts: counts
  };
}

/**
 * Insert network stats
 */
function insertNetworkStats(networkStats) {
  if (!db || !networkStats || networkStats.length === 0) return;

  const timestamp = Date.now();
  const insert = db.prepare(`
    INSERT INTO network_stats (timestamp, interface, rx_bytes_sec, tx_bytes_sec, rx_packets_sec, tx_packets_sec, rx_errors, tx_errors)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const stat of networkStats) {
    insert.run(timestamp, stat.interface, stat.rxBytesPerSec, stat.txBytesPerSec, stat.rxPacketsPerSec, stat.txPacketsPerSec, stat.rxErrors, stat.txErrors);
  }
}

/**
 * Insert container stats
 */
function insertContainerStats(containers) {
  if (!db || !containers || containers.length === 0) return;

  const timestamp = Date.now();
  const insert = db.prepare(`
    INSERT INTO container_stats (timestamp, name, cpu, mem_percent, net_rx, net_tx, block_read, block_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of containers) {
    insert.run(timestamp, c.name, c.cpu, c.memPercent, c.netRx || 0, c.netTx || 0, c.blockRead || 0, c.blockWrite || 0);
  }
}

/**
 * Insert GPU stats
 */
function insertGpuStats(gpus) {
  if (!db || !gpus || gpus.length === 0) return;

  const timestamp = Date.now();
  const insert = db.prepare(`
    INSERT INTO gpu_stats (timestamp, gpu_index, name, usage, memory_usage, temperature, power_draw)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const gpu of gpus) {
    insert.run(timestamp, gpu.index, gpu.name, gpu.usage, gpu.memoryUsage, gpu.temperature, gpu.powerDraw);
  }
}

/**
 * Insert service health check results
 */
function insertServiceHealth(results) {
  if (!db || !results || results.length === 0) return;

  const timestamp = Date.now();
  const insert = db.prepare(`
    INSERT INTO service_health (timestamp, name, url, status, status_code, response_time, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of results) {
    insert.run(timestamp, r.name, r.url, r.status, r.statusCode || null, r.responseTime || null, r.error || null);
  }
}

/**
 * Query network stats history
 */
function queryNetworkStats(start, end, iface = null) {
  if (!db) return [];

  if (iface) {
    return db.prepare(`
      SELECT * FROM network_stats WHERE timestamp >= ? AND timestamp <= ? AND interface = ? ORDER BY timestamp ASC
    `).all(start, end, iface);
  }

  return db.prepare(`
    SELECT * FROM network_stats WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC
  `).all(start, end);
}

/**
 * Query container stats history
 */
function queryContainerStats(start, end, name = null) {
  if (!db) return [];

  if (name) {
    return db.prepare(`
      SELECT * FROM container_stats WHERE timestamp >= ? AND timestamp <= ? AND name = ? ORDER BY timestamp ASC
    `).all(start, end, name);
  }

  return db.prepare(`
    SELECT * FROM container_stats WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC
  `).all(start, end);
}

/**
 * Query GPU stats history
 */
function queryGpuStats(start, end) {
  if (!db) return [];

  return db.prepare(`
    SELECT * FROM gpu_stats WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC
  `).all(start, end);
}

/**
 * Query service health history
 */
function queryServiceHealth(start, end, name = null) {
  if (!db) return [];

  if (name) {
    return db.prepare(`
      SELECT * FROM service_health WHERE timestamp >= ? AND timestamp <= ? AND name = ? ORDER BY timestamp DESC
    `).all(start, end, name);
  }

  return db.prepare(`
    SELECT * FROM service_health WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC
  `).all(start, end);
}

/**
 * Get service uptime percentage
 */
function getServiceUptime(name, days = 30) {
  if (!db) return null;

  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy
    FROM service_health
    WHERE name = ? AND timestamp >= ?
  `).get(name, cutoff);

  if (!stats || stats.total === 0) return null;

  return {
    name,
    days,
    totalChecks: stats.total,
    healthyChecks: stats.healthy,
    uptimePercent: Math.round((stats.healthy / stats.total) * 10000) / 100
  };
}

/**
 * Send Discord webhook notification
 */
async function sendDiscordAlert(alert) {
  if (!DISCORD_WEBHOOK) return;

  const now = Date.now();
  const lastSent = lastDiscordAlert[alert.type] || 0;

  // Cooldown check
  if (now - lastSent < DISCORD_COOLDOWN) return;

  const colors = {
    critical: 15158332, // Red
    warning: 16776960,  // Yellow
    info: 3447003       // Blue
  };

  const embed = {
    title: `⚠️ ${alert.severity.toUpperCase()}: ${alert.type.replace(/_/g, ' ').toUpperCase()}`,
    description: alert.message,
    color: colors[alert.severity] || colors.info,
    fields: [],
    timestamp: new Date().toISOString(),
    footer: { text: 'Home Server Monitor' }
  };

  if (alert.recommendation) {
    embed.fields.push({
      name: '💡 Recommendation',
      value: alert.recommendation,
      inline: false
    });
  }

  try {
    const https = require('https');
    const url = new URL(DISCORD_WEBHOOK);

    const payload = JSON.stringify({ embeds: [embed] });

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    });

    req.on('error', (e) => console.error('Discord webhook error:', e.message));
    req.write(payload);
    req.end();

    lastDiscordAlert[alert.type] = now;
    console.log('Discord alert sent:', alert.type);
  } catch (error) {
    console.error('Failed to send Discord alert:', error.message);
  }
}

/**
 * Close database connection
 */
function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initialize,
  insertMetrics,
  insertTopProcesses,
  insertAlert,
  resolveAlert,
  autoResolveAlerts,
  getAlerts,
  queryMetrics,
  queryCpuCores,
  queryDiskIo,
  queryTopProcesses,
  aggregateHourly,
  cleanup,
  getDbStats,
  close,
  // New exports
  insertNetworkStats,
  insertContainerStats,
  insertGpuStats,
  insertServiceHealth,
  queryNetworkStats,
  queryContainerStats,
  queryGpuStats,
  queryServiceHealth,
  getServiceUptime,
  sendDiscordAlert
};
