const express = require('express');
const cors = require('cors');
const os = require('os');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3005;
const API_KEY = process.env.API_KEY || 'home-stats-key';

app.use(cors());

// Simple API key auth middleware
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key === API_KEY) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
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

// Get all system stats
function getSystemStats() {
  const uptime = os.uptime();
  const loadAvg = os.loadavg();

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
    memory: getMemoryUsage(),
    disk: getDiskUsage(),
    disks: getAllDisks(),
    gpu: getGpuUsage(),
    containers: getDockerStats(),
    network: getNetworkStats(),
    timestamp: new Date().toISOString()
  };
}

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'home-stats-agent' });
});

// Stats endpoint (requires auth)
app.get('/stats', authenticate, (req, res) => {
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Home stats agent running on port ${PORT}`);
  console.log(`Server name: ${process.env.SERVER_NAME || 'Home Server'}`);
});
