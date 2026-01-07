const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3004;
const INCIDENTS_FILE = path.join(__dirname, 'data', 'incidents.json');
const INCIDENTS_RETENTION_DAYS = 90;

// Home server stats agent configuration
const HOME_STATS_URL = process.env.HOME_STATS_URL || 'https://stats.basedsecurity.net/stats';
const HOME_STATS_KEY = process.env.HOME_STATS_KEY || 'home-stats-secret-key';

// Cache for home server stats (refresh every 10 seconds)
let homeStatsCache = null;
let homeStatsCacheTime = 0;
const HOME_STATS_CACHE_TTL = 10000; // 10 seconds

// Enable CORS for all routes
app.use(cors());

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Service definitions - using public endpoints via CloudFront
const services = [
  {
    id: 'portfolio',
    name: 'Terminal Portfolio',
    description: 'Interactive terminal-style portfolio website',
    endpoint: 'https://api.basedsecurity.net/portfolio/health',
    publicUrl: 'https://portfolio.basedsecurity.net',
    category: 'application'
  },
  {
    id: 'shipping',
    name: 'Shipping Monitor',
    description: 'Real-time package tracking dashboard',
    endpoint: 'https://api.basedsecurity.net/shipping/api/health',
    publicUrl: 'https://shipping.basedsecurity.net',
    category: 'application'
  },
  {
    id: 'security',
    name: 'BasedSecurity AI',
    description: 'AI-powered security platform with license management',
    endpoint: 'https://api.basedsecurity.net/security/health',
    publicUrl: 'https://security.basedsecurity.net',
    category: 'application'
  },
  {
    id: 'photos',
    name: 'RapidPhotoFlow',
    description: 'Photo management and AI tagging application',
    endpoint: 'https://api.basedsecurity.net/photos/actuator/health',
    publicUrl: 'https://photos.basedsecurity.net',
    category: 'application'
  },
  {
    id: 'traefik',
    name: 'API Gateway (Traefik)',
    description: 'Reverse proxy and load balancer',
    endpoint: 'https://api.basedsecurity.net/portfolio/health',
    publicUrl: 'https://api.basedsecurity.net',
    category: 'infrastructure'
  },
  // Home Server Services (dynamic IP)
  {
    id: 'jellyfin',
    name: 'Jellyfin Media Server',
    description: 'Media streaming server with GPU transcoding',
    endpoint: 'https://media.basedsecurity.net/System/Info/Public',
    publicUrl: 'https://media.basedsecurity.net',
    category: 'homeserver'
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    description: 'Self-hosted cloud storage and collaboration',
    endpoint: 'https://cloud.basedsecurity.net/status.php',
    publicUrl: 'https://cloud.basedsecurity.net',
    category: 'homeserver'
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    description: 'Self-hosted password manager (Bitwarden compatible)',
    endpoint: 'https://vault.basedsecurity.net/',
    publicUrl: 'https://vault.basedsecurity.net',
    category: 'homeserver'
  },
  {
    id: 'openwebui',
    name: 'Open WebUI + Ollama',
    description: 'Local AI chat interface with Ollama backend',
    endpoint: 'https://ai.basedsecurity.net/',
    publicUrl: 'https://ai.basedsecurity.net',
    category: 'homeserver'
  }
];

// In-memory state tracking
let previousStatuses = {};
let incidents = [];

// Load incidents from file
function loadIncidents() {
  try {
    if (fs.existsSync(INCIDENTS_FILE)) {
      const data = fs.readFileSync(INCIDENTS_FILE, 'utf8');
      incidents = JSON.parse(data);
      // Clean up old incidents
      const cutoff = Date.now() - (INCIDENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      incidents = incidents.filter(i => new Date(i.startedAt).getTime() > cutoff);
      console.log(`Loaded ${incidents.length} incidents from file`);
    }
  } catch (error) {
    console.error('Error loading incidents:', error.message);
    incidents = [];
  }
}

// Save incidents to file
function saveIncidents() {
  try {
    fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2));
  } catch (error) {
    console.error('Error saving incidents:', error.message);
  }
}

// Create a new incident
function createIncident(service, status, message, error) {
  const incident = {
    id: `inc-${Date.now()}-${service.id}`,
    serviceId: service.id,
    serviceName: service.name,
    status: status,
    title: `${service.name} ${status === 'major_outage' ? 'Outage' : 'Degraded Performance'}`,
    message: message,
    error: error || null,
    startedAt: new Date().toISOString(),
    resolvedAt: null,
    updates: [
      {
        timestamp: new Date().toISOString(),
        status: status,
        message: `${service.name} is experiencing ${status === 'major_outage' ? 'an outage' : 'degraded performance'}. ${message}`
      }
    ]
  };

  incidents.unshift(incident);
  saveIncidents();
  console.log(`Created incident: ${incident.title}`);
  return incident;
}

// Resolve an incident
function resolveIncident(serviceId) {
  const activeIncident = incidents.find(i => i.serviceId === serviceId && !i.resolvedAt);
  if (activeIncident) {
    activeIncident.resolvedAt = new Date().toISOString();
    activeIncident.updates.push({
      timestamp: new Date().toISOString(),
      status: 'operational',
      message: `${activeIncident.serviceName} has recovered and is now operational.`
    });
    saveIncidents();
    console.log(`Resolved incident: ${activeIncident.title}`);
  }
}

// Update an existing incident (status change within incident)
function updateIncident(serviceId, newStatus, message) {
  const activeIncident = incidents.find(i => i.serviceId === serviceId && !i.resolvedAt);
  if (activeIncident && activeIncident.status !== newStatus) {
    activeIncident.status = newStatus;
    activeIncident.updates.push({
      timestamp: new Date().toISOString(),
      status: newStatus,
      message: `Status changed to ${newStatus === 'major_outage' ? 'Major Outage' : 'Degraded'}. ${message}`
    });
    saveIncidents();
  }
}

// Check if service has an active incident
function hasActiveIncident(serviceId) {
  return incidents.some(i => i.serviceId === serviceId && !i.resolvedAt);
}

// Check a single service health
async function checkService(service) {
  const startTime = Date.now();

  try {
    if (service.tcpCheck) {
      return {
        ...service,
        status: 'operational',
        responseTime: null,
        lastChecked: new Date().toISOString(),
        message: 'Service running (Docker healthcheck)'
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(service.endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json'
      }
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    let status = 'operational';
    let message = 'All systems operational';

    if (!response.ok) {
      if (response.status >= 500) {
        status = 'major_outage';
        message = `Server error (${response.status})`;
      } else if (response.status >= 400) {
        status = 'degraded';
        message = `Client error (${response.status})`;
      }
    }

    // Try to parse response for additional info
    let data = null;
    try {
      const text = await response.text();
      data = JSON.parse(text);
    } catch (e) {
      // Not JSON, that's okay
    }

    return {
      ...service,
      status,
      responseTime,
      lastChecked: new Date().toISOString(),
      message,
      data
    };

  } catch (error) {
    const responseTime = Date.now() - startTime;

    let status = 'major_outage';
    let message = 'Service unavailable';

    if (error.name === 'AbortError') {
      status = 'degraded';
      message = 'Request timeout (>5s)';
    } else if (error.code === 'ECONNREFUSED') {
      message = 'Connection refused';
    } else if (error.code === 'ENOTFOUND') {
      message = 'Host not found';
    }

    return {
      ...service,
      status,
      responseTime,
      lastChecked: new Date().toISOString(),
      message,
      error: error.message
    };
  }
}

// Get CPU usage percentage
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

  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  const usage = 100 - (idle / total * 100);

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

// Get disk usage (Linux)
function getDiskUsage() {
  try {
    // Use df command for disk usage
    const output = execSync('df -B1 / 2>/dev/null || df -k / 2>/dev/null', { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      // df -B1 format: Filesystem 1B-blocks Used Available Use% Mounted
      // df -k format: Filesystem 1K-blocks Used Available Use% Mounted
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

  return {
    total: 0,
    used: 0,
    available: 0,
    usage: 0
  };
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

// Get GPU usage (NVIDIA)
function getGpuUsage() {
  try {
    // Try nvidia-smi for NVIDIA GPUs
    const output = execSync('nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null', { encoding: 'utf8' });
    const gpus = output.trim().split('\n').filter(line => line).map(line => {
      const parts = line.split(',').map(p => p.trim());
      const memUsed = parseInt(parts[3]) || 0;
      const memTotal = parseInt(parts[4]) || 1;
      return {
        index: parseInt(parts[0]) || 0,
        name: parts[1] || 'Unknown GPU',
        usage: parseFloat(parts[2]) || 0,
        memoryUsed: memUsed * 1024 * 1024, // Convert MB to bytes
        memoryTotal: memTotal * 1024 * 1024,
        memoryUsage: Math.round((memUsed / memTotal) * 100 * 10) / 10,
        temperature: parseInt(parts[5]) || 0,
        powerDraw: parseFloat(parts[6]) || 0
      };
    });
    return gpus;
  } catch (error) {
    // nvidia-smi not available or no NVIDIA GPU
    return [];
  }
}

// Get system stats
function getSystemStats() {
  const uptime = os.uptime();
  const loadAvg = os.loadavg();

  return {
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
    memory: getMemoryUsage(),
    disk: getDiskUsage(),
    gpu: getGpuUsage(),
    containers: getDockerStats(),
    timestamp: new Date().toISOString()
  };
}

// Format uptime to human readable
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Fetch home server stats from agent
async function fetchHomeStats() {
  const now = Date.now();

  // Return cached stats if still valid
  if (homeStatsCache && (now - homeStatsCacheTime) < HOME_STATS_CACHE_TTL) {
    return homeStatsCache;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(HOME_STATS_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'X-API-Key': HOME_STATS_KEY,
        'Accept': 'application/json'
      }
    });

    clearTimeout(timeout);

    if (response.ok) {
      const stats = await response.json();
      homeStatsCache = {
        ...stats,
        available: true,
        lastUpdated: new Date().toISOString()
      };
      homeStatsCacheTime = now;
      return homeStatsCache;
    } else {
      console.error(`Home stats fetch failed: HTTP ${response.status}`);
      return {
        available: false,
        error: `HTTP ${response.status}`,
        lastUpdated: new Date().toISOString()
      };
    }
  } catch (error) {
    console.error('Home stats fetch error:', error.message);
    return {
      available: false,
      error: error.name === 'AbortError' ? 'Timeout' : error.message,
      lastUpdated: new Date().toISOString()
    };
  }
}

// Get combined stats from all servers
async function getAllServerStats() {
  const [cloudStats, homeStats] = await Promise.all([
    Promise.resolve(getSystemStats()),
    fetchHomeStats()
  ]);

  return {
    cloud: {
      serverName: 'Cloud Server (AWS)',
      ...cloudStats
    },
    home: homeStats,
    timestamp: new Date().toISOString()
  };
}

// Check all services and track incidents
async function checkAllServices() {
  const results = await Promise.all(services.map(checkService));

  // Track state changes and manage incidents
  results.forEach(result => {
    const prevStatus = previousStatuses[result.id];
    const currentStatus = result.status;

    if (prevStatus !== currentStatus) {
      if (currentStatus === 'operational' && prevStatus && prevStatus !== 'operational') {
        // Service recovered - resolve incident
        resolveIncident(result.id);
      } else if (currentStatus !== 'operational') {
        if (hasActiveIncident(result.id)) {
          // Update existing incident if status changed (degraded <-> major_outage)
          updateIncident(result.id, currentStatus, result.message);
        } else {
          // Create new incident
          createIncident(result, currentStatus, result.message, result.error);
        }
      }
    }

    previousStatuses[result.id] = currentStatus;
  });

  // Calculate overall status
  const statuses = results.map(r => r.status);
  let overallStatus = 'operational';

  if (statuses.some(s => s === 'major_outage')) {
    overallStatus = 'major_outage';
  } else if (statuses.some(s => s === 'degraded')) {
    overallStatus = 'degraded';
  }

  return {
    overallStatus,
    timestamp: new Date().toISOString(),
    services: results,
    incidents: incidents.slice(0, 20) // Return last 20 incidents
  };
}

// Serve static files at root and /status prefix
app.use(express.static(path.join(__dirname, 'public')));
app.use('/status', express.static(path.join(__dirname, 'public')));

// Health check endpoint (both paths for flexibility)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'status-page' });
});
app.get('/status/health', (req, res) => {
  res.json({ status: 'ok', service: 'status-page' });
});

// Status API endpoint (both paths for flexibility)
async function handleStatusRequest(req, res) {
  try {
    const status = await checkAllServices();
    res.json(status);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check services',
      message: error.message
    });
  }
}
app.get('/api/status', handleStatusRequest);
app.get('/status/api/status', handleStatusRequest);

// Incidents API endpoint
app.get('/api/incidents', (req, res) => {
  res.json({ incidents: incidents.slice(0, 50) });
});
app.get('/status/api/incidents', (req, res) => {
  res.json({ incidents: incidents.slice(0, 50) });
});

// System stats API endpoint
app.get('/api/system', (req, res) => {
  try {
    const stats = getSystemStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get system stats',
      message: error.message
    });
  }
});
app.get('/status/api/system', (req, res) => {
  try {
    const stats = getSystemStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get system stats',
      message: error.message
    });
  }
});

// Combined server stats API endpoint (cloud + home)
async function handleServersRequest(req, res) {
  try {
    const stats = await getAllServerStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get server stats',
      message: error.message
    });
  }
}
app.get('/api/servers', handleServersRequest);
app.get('/status/api/servers', handleServersRequest);

// ============ HOME AUDIT ENDPOINTS ============
// Get base URL for home agent (remove /stats from HOME_STATS_URL)
const HOME_AGENT_BASE = HOME_STATS_URL.replace(/\/stats$/, '');

// Helper to proxy requests to home agent
async function proxyToHomeAgent(endpoint, res, queryParams = '') {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const url = `${HOME_AGENT_BASE}${endpoint}${queryParams ? '?' + queryParams : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'X-API-Key': HOME_STATS_KEY,
        'Accept': 'application/json'
      }
    });

    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      res.json(data);
    } else {
      res.status(response.status).json({
        error: `Home agent returned ${response.status}`,
        message: await response.text()
      });
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      res.status(504).json({ error: 'Request timeout', message: 'Home agent did not respond in time' });
    } else {
      res.status(502).json({ error: 'Failed to reach home agent', message: error.message });
    }
  }
}

// Detailed audit stats from home server
async function handleHomeAudit(req, res) {
  await proxyToHomeAgent('/stats/detailed', res);
}
app.get('/api/home/audit', handleHomeAudit);
app.get('/status/api/home/audit', handleHomeAudit);

// Historical metrics from home server
async function handleHomeHistory(req, res) {
  const params = new URLSearchParams();
  if (req.query.start) params.set('start', req.query.start);
  if (req.query.end) params.set('end', req.query.end);
  if (req.query.resolution) params.set('resolution', req.query.resolution);
  await proxyToHomeAgent('/history/metrics', res, params.toString());
}
app.get('/api/home/history', handleHomeHistory);
app.get('/status/api/home/history', handleHomeHistory);

// Per-core CPU history
async function handleHomeCores(req, res) {
  const params = new URLSearchParams();
  if (req.query.start) params.set('start', req.query.start);
  if (req.query.end) params.set('end', req.query.end);
  if (req.query.core) params.set('core', req.query.core);
  await proxyToHomeAgent('/history/cores', res, params.toString());
}
app.get('/api/home/cores', handleHomeCores);
app.get('/status/api/home/cores', handleHomeCores);

// Disk I/O history
async function handleHomeDiskIo(req, res) {
  const params = new URLSearchParams();
  if (req.query.start) params.set('start', req.query.start);
  if (req.query.end) params.set('end', req.query.end);
  if (req.query.device) params.set('device', req.query.device);
  await proxyToHomeAgent('/history/disk-io', res, params.toString());
}
app.get('/api/home/disk-io', handleHomeDiskIo);
app.get('/status/api/home/disk-io', handleHomeDiskIo);

// Alerts from home server
async function handleHomeAlerts(req, res) {
  const params = new URLSearchParams();
  if (req.query.limit) params.set('limit', req.query.limit);
  await proxyToHomeAgent('/alerts', res, params.toString());
}
app.get('/api/home/alerts', handleHomeAlerts);
app.get('/status/api/home/alerts', handleHomeAlerts);

// Bottleneck analysis
async function handleHomeAnalysis(req, res) {
  await proxyToHomeAgent('/analysis/bottlenecks', res);
}
app.get('/api/home/analysis', handleHomeAnalysis);
app.get('/status/api/home/analysis', handleHomeAnalysis);

// Database stats from home agent
async function handleHomeDbStats(req, res) {
  await proxyToHomeAgent('/db/stats', res);
}
app.get('/api/home/db-stats', handleHomeDbStats);
app.get('/status/api/home/db-stats', handleHomeDbStats);

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize
loadIncidents();

// Background health check every 60 seconds to track incidents even when no one is viewing
setInterval(async () => {
  try {
    await checkAllServices();
  } catch (error) {
    console.error('Background health check failed:', error.message);
  }
}, 60000);

// Initial check on startup
checkAllServices().then(() => {
  console.log('Initial health check completed');
}).catch(err => {
  console.error('Initial health check failed:', err.message);
});

app.listen(PORT, () => {
  console.log(`Status page running on port ${PORT}`);
});
