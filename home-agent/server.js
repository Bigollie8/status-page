const express = require('express');
const cors = require('cors');
const os = require('os');
const { execSync } = require('child_process');
const metrics = require('./metrics');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3005;
const API_KEY = process.env.API_KEY || 'home-stats-key';

// Collection intervals (configurable via environment variables)
const METRICS_INTERVAL = parseInt(process.env.METRICS_INTERVAL) || 10000;  // Default 10 seconds
const PROCESS_INTERVAL = parseInt(process.env.PROCESS_INTERVAL) || 60000; // Default 60 seconds
const CONTAINER_INTERVAL = parseInt(process.env.CONTAINER_INTERVAL) || 60000; // Default 60 seconds
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL) || 60000; // Default 60 seconds
const CLEANUP_INTERVAL = parseInt(process.env.CLEANUP_INTERVAL) || 3600000; // Default 1 hour

// Configurable services for health checks
const MONITORED_SERVICES = JSON.parse(process.env.MONITORED_SERVICES || '[]') || [
  { name: 'Jellyfin', url: 'http://localhost:8096/health' },
  { name: 'Nextcloud', url: 'http://localhost:8080/status.php' },
  { name: 'Vaultwarden', url: 'http://localhost:8081/alive' },
  { name: 'Ollama', url: 'http://localhost:11434/api/tags' }
];

app.use(cors());
app.use(express.json());

// Initialize metrics and database
metrics.initialize();
db.initialize();

// Simple API key auth middleware
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key === API_KEY) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Previous CPU stats for delta-based calculation
let prevCpuTimes = null;

// Get CPU usage percentage using delta-based measurement for accuracy
function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });

  let usage = 0;

  // Calculate delta-based usage if we have previous stats
  if (prevCpuTimes) {
    const deltaIdle = totalIdle - prevCpuTimes.idle;
    const deltaTotal = totalTick - prevCpuTimes.total;

    if (deltaTotal > 0) {
      usage = 100 - (deltaIdle / deltaTotal * 100);
    }
  }

  // Store current values for next calculation
  prevCpuTimes = { idle: totalIdle, total: totalTick };

  return {
    usage: Math.round(usage * 10) / 10,
    cores: cpus.length,
    model: cpus[0]?.model || 'Unknown'
  };
}

// Get memory usage
function getMemoryUsage() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const usagePercent = (usedMem / totalMem) * 100;

  return {
    total: totalMem,
    used: usedMem,
    free: freeMem,
    usage: Math.round(usagePercent * 10) / 10
  };
}

// Get disk usage
function getDiskUsage() {
  try {
    const output = execSync('df -B1 / 2>/dev/null || df -k / 2>/dev/null', { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const multiplier = output.includes('1B-blocks') ? 1 : 1024;
      const total = parseInt(parts[1]) * multiplier;
      const used = parseInt(parts[2]) * multiplier;
      const available = parseInt(parts[3]) * multiplier;
      const usagePercent = (used / total) * 100;

      return {
        total,
        used,
        available,
        usage: Math.round(usagePercent * 10) / 10
      };
    }
  } catch (error) {
    console.error('Error getting disk usage:', error.message);
  }

  return { total: 0, used: 0, available: 0, usage: 0 };
}

// Get all disk mounts
function getAllDisks() {
  try {
    const output = execSync('df -B1 -x tmpfs -x devtmpfs -x overlay 2>/dev/null || df -k 2>/dev/null', { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    const disks = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(/\s+/);
      if (parts.length >= 6 && !parts[0].startsWith('tmpfs')) {
        const multiplier = output.includes('1B-blocks') ? 1 : 1024;
        const total = parseInt(parts[1]) * multiplier;
        const used = parseInt(parts[2]) * multiplier;
        const available = parseInt(parts[3]) * multiplier;

        if (total > 1073741824) { // Only show disks > 1GB
          disks.push({
            mount: parts[5],
            filesystem: parts[0],
            total,
            used,
            available,
            usage: Math.round((used / total) * 100 * 10) / 10
          });
        }
      }
    }
    return disks;
  } catch (error) {
    return [];
  }
}

// Get GPU usage (NVIDIA)
function getGpuUsage() {
  try {
    const output = execSync('nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null', { encoding: 'utf8' });
    const gpus = output.trim().split('\n').filter(line => line).map(line => {
      const parts = line.split(',').map(p => p.trim());
      const memUsed = parseInt(parts[3]) || 0;
      const memTotal = parseInt(parts[4]) || 1;
      return {
        index: parseInt(parts[0]) || 0,
        name: parts[1] || 'Unknown GPU',
        usage: parseFloat(parts[2]) || 0,
        memoryUsed: memUsed * 1024 * 1024,
        memoryTotal: memTotal * 1024 * 1024,
        memoryUsage: Math.round((memUsed / memTotal) * 100 * 10) / 10,
        temperature: parseInt(parts[5]) || 0,
        powerDraw: parseFloat(parts[6]) || 0
      };
    });
    return gpus;
  } catch (error) {
    return [];
  }
}

// Get Docker container stats
function getDockerStats() {
  try {
    const output = execSync('docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}" 2>/dev/null', { encoding: 'utf8' });
    const containers = output.trim().split('\n').filter(line => line).map(line => {
      const [name, cpu, memUsage, memPerc] = line.split(',');
      return {
        name,
        cpu: parseFloat(cpu) || 0,
        memUsage: memUsage || '0B / 0B',
        memPercent: parseFloat(memPerc) || 0
      };
    });
    return containers;
  } catch (error) {
    return [];
  }
}

// Get network stats
function getNetworkStats() {
  try {
    const interfaces = os.networkInterfaces();
    const stats = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
      if (name === 'lo' || name.startsWith('docker') || name.startsWith('br-') || name.startsWith('veth')) continue;

      const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
      if (ipv4) {
        stats.push({
          interface: name,
          ip: ipv4.address,
          mac: ipv4.mac
        });
      }
    }
    return stats;
  } catch (error) {
    return [];
  }
}

// Format uptime
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Get all system stats (uses host data when available)
function getSystemStats() {
  const uptime = os.uptime();
  const loadAvg = os.loadavg();

  // Use host disk data if available, fallback to container mounts
  const hostDisks = metrics.getHostDiskUsage();
  const gpuInfo = metrics.getGpuInfo();
  const hostMemory = metrics.getHostMemory();

  return {
    serverName: process.env.SERVER_NAME || 'Home Server',
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: uptime,
    uptimeFormatted: formatUptime(uptime),
    loadAverage: {
      '1m': Math.round(loadAvg[0] * 100) / 100,
      '5m': Math.round(loadAvg[1] * 100) / 100,
      '15m': Math.round(loadAvg[2] * 100) / 100
    },
    cpu: getCpuUsage(),
    memory: hostMemory.total > 0 ? hostMemory : getMemoryUsage(),
    disk: hostDisks.length > 0 ? hostDisks[0] : getDiskUsage(),
    disks: hostDisks.length > 0 ? hostDisks : getAllDisks(),
    gpu: gpuInfo.length > 0 ? gpuInfo : getGpuUsage(),
    containers: getDockerStats(),
    network: getNetworkStats(),
    timestamp: new Date().toISOString()
  };
}

// Get detailed system stats with enhanced metrics
function getDetailedStats() {
  const basicStats = getSystemStats();
  const detailedMetrics = metrics.getDetailedMetrics();
  const hostDisks = metrics.getHostDiskUsage();
  const gpuInfo = metrics.getGpuInfo();

  return {
    ...basicStats,
    cpu: {
      ...basicStats.cpu,
      perCore: detailedMetrics.perCoreCpu,
      extended: detailedMetrics.cpuExtended,
      temperature: detailedMetrics.cpuTemperature
    },
    memory: {
      ...basicStats.memory,
      pressure: detailedMetrics.memoryPressure
    },
    // Use host disks if available, fallback to container disks
    disks: hostDisks.length > 0 ? hostDisks : basicStats.disks,
    diskIo: detailedMetrics.diskIo,
    // Use GPU info from metrics module
    gpu: gpuInfo.length > 0 ? gpuInfo : basicStats.gpu,
    processes: detailedMetrics.topProcesses,
    kernel: detailedMetrics.kernelStats,
    bottlenecks: detailedMetrics.bottlenecks
  };
}

// Background metrics collection
let lastProcessCollection = 0;
let lastContainerCollection = 0;
let lastHealthCheck = 0;
let cachedServiceHealth = [];

function collectMetrics() {
  try {
    const detailedMetrics = metrics.getDetailedMetrics();
    const basicStats = getSystemStats();
    const networkStats = metrics.getNetworkStats();
    const gpuInfo = metrics.getGpuInfo();

    // Merge for storage
    const fullMetrics = {
      ...detailedMetrics,
      memory: basicStats.memory,
      loadAverage: basicStats.loadAverage
    };

    // Store metrics
    db.insertMetrics(fullMetrics);

    // Store network stats
    if (networkStats && networkStats.length > 0) {
      db.insertNetworkStats(networkStats);
    }

    // Store GPU stats
    if (gpuInfo && gpuInfo.length > 0) {
      db.insertGpuStats(gpuInfo);
    }

    // Store processes less frequently
    const now = Date.now();
    if (now - lastProcessCollection >= PROCESS_INTERVAL) {
      db.insertTopProcesses(detailedMetrics.topProcesses);
      lastProcessCollection = now;
    }

    // Store container stats less frequently
    if (now - lastContainerCollection >= CONTAINER_INTERVAL) {
      const containers = metrics.getContainerStats();
      if (containers && containers.length > 0) {
        db.insertContainerStats(containers);
      }
      lastContainerCollection = now;
    }

    // Handle alerts and Discord notifications
    for (const bottleneck of detailedMetrics.bottlenecks) {
      db.insertAlert(bottleneck);
      // Send Discord notification for critical alerts
      if (bottleneck.severity === 'critical') {
        db.sendDiscordAlert(bottleneck);
      }
    }
    db.autoResolveAlerts(detailedMetrics.bottlenecks);

  } catch (error) {
    console.error('Error collecting metrics:', error.message);
  }
}

// Service health check collection
async function collectServiceHealth() {
  try {
    if (MONITORED_SERVICES.length === 0) return;

    const results = await metrics.checkServiceHealth(MONITORED_SERVICES);
    cachedServiceHealth = results;
    db.insertServiceHealth(results);

    // Alert on service failures
    for (const result of results) {
      if (result.status === 'down' || result.status === 'timeout') {
        const alert = {
          type: 'service_down',
          severity: 'critical',
          message: `Service ${result.name} is ${result.status}`,
          recommendation: `Check if ${result.name} is running and accessible at ${result.url}`
        };
        db.insertAlert(alert);
        db.sendDiscordAlert(alert);
      }
    }
  } catch (error) {
    console.error('Error checking service health:', error.message);
  }
}

function runCleanup() {
  try {
    db.aggregateHourly();
    db.cleanup();
    console.log('Cleanup completed. DB stats:', db.getDbStats());
  } catch (error) {
    console.error('Error during cleanup:', error.message);
  }
}

// Start background collection
setInterval(collectMetrics, METRICS_INTERVAL);
setInterval(runCleanup, CLEANUP_INTERVAL);
setInterval(collectServiceHealth, HEALTH_CHECK_INTERVAL);

// Initial collection after short delay
setTimeout(collectMetrics, 2000);
setTimeout(collectServiceHealth, 5000);

// ============ ENDPOINTS ============

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'home-stats-agent', version: '2.0.0' });
});

// Configuration endpoint - returns current refresh intervals
app.get('/config', authenticate, (req, res) => {
  res.json({
    intervals: {
      metrics: METRICS_INTERVAL,
      process: PROCESS_INTERVAL,
      container: CONTAINER_INTERVAL,
      healthCheck: HEALTH_CHECK_INTERVAL,
      cleanup: CLEANUP_INTERVAL
    },
    description: {
      metrics: 'System stats collection interval (ms)',
      process: 'Top processes collection interval (ms)',
      container: 'Container stats collection interval (ms)',
      healthCheck: 'Service health check interval (ms)',
      cleanup: 'Data cleanup/aggregation interval (ms)'
    }
  });
});

// Stats endpoint - legacy format (requires auth)
app.get('/stats', authenticate, (req, res) => {
  try {
    const stats = getSystemStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get system stats', message: error.message });
  }
});

// Detailed stats endpoint with all enhanced metrics
app.get('/stats/detailed', authenticate, (req, res) => {
  try {
    const stats = getDetailedStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get detailed stats', message: error.message });
  }
});

// Historical metrics query
app.get('/history/metrics', authenticate, (req, res) => {
  try {
    const end = parseInt(req.query.end) || Date.now();
    const start = parseInt(req.query.start) || (end - 3600000); // Default: last hour
    const resolution = req.query.resolution || 'raw';

    const data = db.queryMetrics(start, end, resolution);
    res.json({ start, end, resolution, count: data.length, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query metrics', message: error.message });
  }
});

// Per-core CPU history
app.get('/history/cores', authenticate, (req, res) => {
  try {
    const end = parseInt(req.query.end) || Date.now();
    const start = parseInt(req.query.start) || (end - 3600000);
    const coreId = req.query.core !== undefined ? parseInt(req.query.core) : null;

    const data = db.queryCpuCores(start, end, coreId);
    res.json({ start, end, coreId, count: data.length, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query CPU cores', message: error.message });
  }
});

// Disk I/O history
app.get('/history/disk-io', authenticate, (req, res) => {
  try {
    const end = parseInt(req.query.end) || Date.now();
    const start = parseInt(req.query.start) || (end - 3600000);
    const device = req.query.device || null;

    const data = db.queryDiskIo(start, end, device);
    res.json({ start, end, device, count: data.length, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query disk I/O', message: error.message });
  }
});

// Top processes history
app.get('/history/processes', authenticate, (req, res) => {
  try {
    const end = parseInt(req.query.end) || Date.now();
    const start = parseInt(req.query.start) || (end - 3600000);

    const data = db.queryTopProcesses(start, end);
    res.json({ start, end, count: data.length, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query processes', message: error.message });
  }
});

// Get alerts
app.get('/alerts', authenticate, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const alerts = db.getAlerts(limit);
    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get alerts', message: error.message });
  }
});

// Resolve an alert
app.post('/alerts/:id/resolve', authenticate, (req, res) => {
  try {
    db.resolveAlert(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to resolve alert', message: error.message });
  }
});

// Get bottleneck analysis
app.get('/analysis/bottlenecks', authenticate, (req, res) => {
  try {
    const detailedMetrics = metrics.getDetailedMetrics();
    res.json({
      timestamp: new Date().toISOString(),
      bottlenecks: detailedMetrics.bottlenecks,
      summary: {
        cpuCoreSaturation: detailedMetrics.bottlenecks.some(b => b.type === 'cpu_core_saturation'),
        highIoWait: detailedMetrics.bottlenecks.some(b => b.type === 'high_iowait'),
        memoryPressure: detailedMetrics.bottlenecks.some(b => b.type === 'memory_pressure'),
        thermalThrottling: detailedMetrics.bottlenecks.some(b => b.type === 'thermal_throttle'),
        diskLatency: detailedMetrics.bottlenecks.some(b => b.type === 'disk_latency')
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to analyze bottlenecks', message: error.message });
  }
});

// Database stats
app.get('/db/stats', authenticate, (req, res) => {
  try {
    const stats = db.getDbStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get DB stats', message: error.message });
  }
});

// ============ NEW ENDPOINTS ============

// Network stats (current)
app.get('/stats/network', authenticate, (req, res) => {
  try {
    const networkStats = metrics.getNetworkStats();
    res.json(networkStats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get network stats', message: error.message });
  }
});

// Network stats history
app.get('/history/network', authenticate, (req, res) => {
  try {
    const end = parseInt(req.query.end) || Date.now();
    const start = parseInt(req.query.start) || (end - 3600000);
    const iface = req.query.interface || null;
    const data = db.queryNetworkStats(start, end, iface);
    res.json({ start, end, interface: iface, count: data.length, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query network stats', message: error.message });
  }
});

// Container stats history
app.get('/history/containers', authenticate, (req, res) => {
  try {
    const end = parseInt(req.query.end) || Date.now();
    const start = parseInt(req.query.start) || (end - 3600000);
    const name = req.query.name || null;
    const data = db.queryContainerStats(start, end, name);
    res.json({ start, end, name, count: data.length, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query container stats', message: error.message });
  }
});

// GPU stats history
app.get('/history/gpu', authenticate, (req, res) => {
  try {
    const end = parseInt(req.query.end) || Date.now();
    const start = parseInt(req.query.start) || (end - 3600000);
    const data = db.queryGpuStats(start, end);
    res.json({ start, end, count: data.length, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query GPU stats', message: error.message });
  }
});

// Service health (current)
app.get('/services/health', authenticate, (req, res) => {
  try {
    res.json({
      services: cachedServiceHealth,
      lastCheck: cachedServiceHealth[0]?.lastCheck || null
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get service health', message: error.message });
  }
});

// Service health history
app.get('/history/services', authenticate, (req, res) => {
  try {
    const end = parseInt(req.query.end) || Date.now();
    const start = parseInt(req.query.start) || (end - 86400000); // Default 24h
    const name = req.query.name || null;
    const data = db.queryServiceHealth(start, end, name);
    res.json({ start, end, name, count: data.length, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query service health', message: error.message });
  }
});

// Service uptime
app.get('/services/uptime', authenticate, (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const uptimes = [];
    for (const service of MONITORED_SERVICES) {
      const uptime = db.getServiceUptime(service.name, days);
      if (uptime) {
        uptimes.push(uptime);
      } else {
        uptimes.push({ name: service.name, uptimePercent: null, totalChecks: 0 });
      }
    }
    res.json(uptimes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get service uptime', message: error.message });
  }
});

// SMART disk health
app.get('/stats/smart', authenticate, (req, res) => {
  try {
    const smartData = metrics.getSmartHealth();
    res.json(smartData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get SMART data', message: error.message });
  }
});

// Disk predictions
app.get('/stats/disk-predictions', authenticate, (req, res) => {
  try {
    const hostDisks = metrics.getHostDiskUsage();
    const predictions = metrics.getDiskPredictions(hostDisks);
    res.json({
      disks: hostDisks,
      predictions,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get disk predictions', message: error.message });
  }
});

// Test Discord webhook
app.post('/test/discord', authenticate, (req, res) => {
  try {
    const testAlert = {
      type: 'test_alert',
      severity: 'info',
      message: 'Test alert from Home Server Monitor',
      recommendation: 'This is a test notification. If you received this, Discord alerts are working!'
    };
    db.sendDiscordAlert(testAlert);
    res.json({ success: true, message: 'Test alert sent' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send test alert', message: error.message });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing database...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing database...');
  db.close();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Home stats agent v2.0.0 running on port ${PORT}`);
  console.log(`Server name: ${process.env.SERVER_NAME || 'Home Server'}`);
  console.log(`Metrics collection: every ${METRICS_INTERVAL / 1000}s`);
  console.log(`Process collection: every ${PROCESS_INTERVAL / 1000}s`);
});
