/**
 * Enhanced system metrics collection module
 * Collects detailed CPU, memory, disk, and process metrics for bottleneck analysis
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

// Use host paths if running in container
const PROC_PATH = process.env.HOST_PROC || '/host/proc';
const SYS_PATH = process.env.HOST_SYS || '/host/sys';
const HOST_DRIVES = process.env.HOST_DRIVES || '/host/drives';

// Previous values for calculating rates
let prevCpuStats = null;
let prevDiskStats = null;
let prevKernelStats = null;
let prevTimestamp = null;

/**
 * Get per-core CPU utilization from /proc/stat
 * Returns usage breakdown for each core: user, system, iowait, steal, irq
 */
function getPerCoreCpu() {
  try {
    const stat = fs.readFileSync(`${PROC_PATH}/stat`, 'utf8');
    const lines = stat.split('\n');
    const cores = [];
    const currentStats = {};

    for (const line of lines) {
      if (line.startsWith('cpu') && line[3] !== ' ') {
        const parts = line.split(/\s+/);
        const coreId = parseInt(parts[0].replace('cpu', ''));
        const user = parseInt(parts[1]) + parseInt(parts[2]); // user + nice
        const system = parseInt(parts[3]);
        const idle = parseInt(parts[4]);
        const iowait = parseInt(parts[5]) || 0;
        const irq = (parseInt(parts[6]) || 0) + (parseInt(parts[7]) || 0);
        const steal = parseInt(parts[8]) || 0;

        currentStats[coreId] = { user, system, idle, iowait, irq, steal };

        // Calculate percentages if we have previous data
        if (prevCpuStats && prevCpuStats[coreId]) {
          const prev = prevCpuStats[coreId];
          const dUser = user - prev.user;
          const dSystem = system - prev.system;
          const dIdle = idle - prev.idle;
          const dIowait = iowait - prev.iowait;
          const dIrq = irq - prev.irq;
          const dSteal = steal - prev.steal;
          const dTotal = dUser + dSystem + dIdle + dIowait + dIrq + dSteal;

          if (dTotal > 0) {
            cores.push({
              core: coreId,
              usage: Math.round(((dTotal - dIdle - dIowait) / dTotal) * 1000) / 10,
              user: Math.round((dUser / dTotal) * 1000) / 10,
              system: Math.round((dSystem / dTotal) * 1000) / 10,
              iowait: Math.round((dIowait / dTotal) * 1000) / 10,
              steal: Math.round((dSteal / dTotal) * 1000) / 10,
              irq: Math.round((dIrq / dTotal) * 1000) / 10
            });
          }
        }
      }
    }

    prevCpuStats = currentStats;
    return cores.sort((a, b) => a.core - b.core);
  } catch (error) {
    console.error('Error getting per-core CPU:', error.message);
    return [];
  }
}

/**
 * Get system-wide CPU breakdown (iowait, steal, irq, etc.)
 */
function getCpuExtended() {
  try {
    const stat = fs.readFileSync(`${PROC_PATH}/stat`, 'utf8');
    const cpuLine = stat.split('\n').find(l => l.startsWith('cpu '));
    if (!cpuLine) return null;

    const parts = cpuLine.split(/\s+/);
    const user = parseInt(parts[1]) + parseInt(parts[2]);
    const system = parseInt(parts[3]);
    const idle = parseInt(parts[4]);
    const iowait = parseInt(parts[5]) || 0;
    const irq = (parseInt(parts[6]) || 0) + (parseInt(parts[7]) || 0);
    const steal = parseInt(parts[8]) || 0;
    const total = user + system + idle + iowait + irq + steal;

    return {
      user: Math.round((user / total) * 1000) / 10,
      system: Math.round((system / total) * 1000) / 10,
      idle: Math.round((idle / total) * 1000) / 10,
      iowait: Math.round((iowait / total) * 1000) / 10,
      steal: Math.round((steal / total) * 1000) / 10,
      irq: Math.round((irq / total) * 1000) / 10
    };
  } catch (error) {
    console.error('Error getting CPU extended:', error.message);
    return null;
  }
}

/**
 * Get disk I/O statistics from /proc/diskstats
 * Returns IOPS, throughput, latency, and queue depth
 */
function getDiskIo() {
  try {
    const diskstats = fs.readFileSync(`${PROC_PATH}/diskstats`, 'utf8');
    const lines = diskstats.split('\n');
    const disks = [];
    const currentStats = {};
    const now = Date.now();
    const timeDelta = prevTimestamp ? (now - prevTimestamp) / 1000 : 1;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 14) continue;

      const device = parts[2];
      // Only physical disks (sd*, nvme*, vd*)
      if (!/^(sd[a-z]|nvme\d+n\d+|vd[a-z])$/.test(device)) continue;

      const stats = {
        readsCompleted: parseInt(parts[3]),
        readsMerged: parseInt(parts[4]),
        sectorsRead: parseInt(parts[5]),
        readTimeMs: parseInt(parts[6]),
        writesCompleted: parseInt(parts[7]),
        writesMerged: parseInt(parts[8]),
        sectorsWritten: parseInt(parts[9]),
        writeTimeMs: parseInt(parts[10]),
        ioInProgress: parseInt(parts[11]),
        ioTimeMs: parseInt(parts[12]),
        weightedIoTimeMs: parseInt(parts[13])
      };

      currentStats[device] = stats;

      // Calculate rates if we have previous data
      if (prevDiskStats && prevDiskStats[device]) {
        const prev = prevDiskStats[device];
        const readIops = (stats.readsCompleted - prev.readsCompleted) / timeDelta;
        const writeIops = (stats.writesCompleted - prev.writesCompleted) / timeDelta;
        const readBytes = ((stats.sectorsRead - prev.sectorsRead) * 512) / timeDelta;
        const writeBytes = ((stats.sectorsWritten - prev.sectorsWritten) * 512) / timeDelta;
        const ioOps = (stats.readsCompleted - prev.readsCompleted) + (stats.writesCompleted - prev.writesCompleted);
        const ioTime = (stats.readTimeMs - prev.readTimeMs) + (stats.writeTimeMs - prev.writeTimeMs);
        const avgLatency = ioOps > 0 ? ioTime / ioOps : 0;
        const ioTimeDelta = stats.ioTimeMs - prev.ioTimeMs;
        const utilization = Math.min(100, (ioTimeDelta / (timeDelta * 1000)) * 100);

        disks.push({
          device,
          readIops: Math.round(readIops * 10) / 10,
          writeIops: Math.round(writeIops * 10) / 10,
          readBytesPerSec: Math.round(readBytes),
          writeBytesPerSec: Math.round(writeBytes),
          avgLatencyMs: Math.round(avgLatency * 10) / 10,
          queueDepth: stats.ioInProgress,
          utilization: Math.round(utilization * 10) / 10
        });
      }
    }

    prevDiskStats = currentStats;
    prevTimestamp = now;
    return disks;
  } catch (error) {
    console.error('Error getting disk I/O:', error.message);
    return [];
  }
}

/**
 * Get memory pressure metrics including swap and page faults
 */
function getMemoryPressure() {
  try {
    const meminfo = fs.readFileSync(`${PROC_PATH}/meminfo`, 'utf8');
    const vmstat = fs.readFileSync(`${PROC_PATH}/vmstat`, 'utf8');

    const parseMeminfo = (key) => {
      const match = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
      return match ? parseInt(match[1]) * 1024 : 0;
    };

    const parseVmstat = (key) => {
      const match = vmstat.match(new RegExp(`${key}\\s+(\\d+)`));
      return match ? parseInt(match[1]) : 0;
    };

    const swapTotal = parseMeminfo('SwapTotal');
    const swapFree = parseMeminfo('SwapFree');
    const swapUsed = swapTotal - swapFree;

    return {
      swapTotal,
      swapFree,
      swapUsed,
      swapUsage: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0,
      cached: parseMeminfo('Cached'),
      buffers: parseMeminfo('Buffers'),
      available: parseMeminfo('MemAvailable'),
      dirty: parseMeminfo('Dirty'),
      pageFaultsMinor: parseVmstat('pgfault'),
      pageFaultsMajor: parseVmstat('pgmajfault'),
      pagesSwappedIn: parseVmstat('pswpin'),
      pagesSwappedOut: parseVmstat('pswpout')
    };
  } catch (error) {
    console.error('Error getting memory pressure:', error.message);
    return null;
  }
}

/**
 * Get top processes by CPU and memory usage
 * Tries to read from host /proc if available
 */
function getTopProcesses(limit = 10) {
  try {
    // Try to get host processes by reading from host /proc
    if (fs.existsSync(`${PROC_PATH}/1/comm`)) {
      return getHostProcesses(limit);
    }

    // Fallback to container processes
    const output = execSync(
      `ps aux --sort=-%cpu 2>/dev/null | head -${limit + 1}`,
      { encoding: 'utf8', timeout: 5000 }
    );

    const processes = [];
    const lines = output.split('\n').filter(l => l.trim());

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      if (isNaN(pid) || isNaN(cpu)) continue;

      processes.push({
        user: parts[0],
        pid,
        cpu,
        memory: parseFloat(parts[3]) || 0,
        vsz: parseInt(parts[4]) * 1024 || 0,
        rss: parseInt(parts[5]) * 1024 || 0,
        stat: parts[7] || '',
        command: parts.slice(10).join(' ').substring(0, 80)
      });
    }
    return processes;
  } catch (error) {
    console.error('Error getting top processes:', error.message);
    return [];
  }
}

/**
 * Get host processes from mounted /proc
 */
function getHostProcesses(limit = 10) {
  try {
    const processes = [];
    const procDirs = fs.readdirSync(PROC_PATH).filter(f => /^\d+$/.test(f));

    for (const pid of procDirs) {
      try {
        const statPath = `${PROC_PATH}/${pid}/stat`;
        const statusPath = `${PROC_PATH}/${pid}/status`;
        const cmdlinePath = `${PROC_PATH}/${pid}/cmdline`;

        if (!fs.existsSync(statPath)) continue;

        const stat = fs.readFileSync(statPath, 'utf8');
        const statParts = stat.split(' ');

        // Get command name
        let command = statParts[1].replace(/[()]/g, '');
        try {
          const cmdline = fs.readFileSync(cmdlinePath, 'utf8').replace(/\0/g, ' ').trim();
          if (cmdline) command = cmdline.substring(0, 80);
        } catch (e) {}

        // Parse stat for CPU times
        const utime = parseInt(statParts[13]) || 0;
        const stime = parseInt(statParts[14]) || 0;
        const rss = (parseInt(statParts[23]) || 0) * 4096; // RSS in pages * page size

        // Get user from status
        let user = 'unknown';
        try {
          const status = fs.readFileSync(statusPath, 'utf8');
          const uidMatch = status.match(/Uid:\s+(\d+)/);
          if (uidMatch) user = `uid:${uidMatch[1]}`;
        } catch (e) {}

        processes.push({
          pid: parseInt(pid),
          user,
          cpu: 0, // Will need delta calculation
          memory: 0,
          rss,
          cpuTime: utime + stime,
          command
        });
      } catch (e) {
        continue;
      }
    }

    // Sort by RSS (memory) since we can't easily get CPU % without deltas
    return processes.sort((a, b) => b.rss - a.rss).slice(0, limit);
  } catch (error) {
    console.error('Error getting host processes:', error.message);
    return [];
  }
}

/**
 * Get CPU temperature from various sources
 */
function getCpuTemperature() {
  const sources = [
    `${SYS_PATH}/class/thermal/thermal_zone0/temp`,
    `${SYS_PATH}/class/hwmon/hwmon0/temp1_input`,
    `${SYS_PATH}/class/hwmon/hwmon1/temp1_input`,
    `${SYS_PATH}/class/hwmon/hwmon2/temp1_input`
  ];

  for (const source of sources) {
    try {
      const temp = parseInt(fs.readFileSync(source, 'utf8').trim());
      if (temp > 0) {
        return {
          celsius: Math.round((temp / 1000) * 10) / 10,
          source: source.replace(SYS_PATH, '/sys')
        };
      }
    } catch (e) {
      continue;
    }
  }

  // Try lm-sensors as fallback
  try {
    const output = execSync('sensors 2>/dev/null | grep -i "core 0\\|tctl\\|cpu" | head -1', { encoding: 'utf8', timeout: 3000 });
    const match = output.match(/[+]?(\d+\.?\d*)[°]?C/);
    if (match) {
      return { celsius: parseFloat(match[1]), source: 'lm-sensors' };
    }
  } catch (e) {
    // Ignore
  }

  return null;
}

/**
 * Get kernel statistics: context switches, interrupts, runnable processes
 */
function getKernelStats() {
  try {
    const stat = fs.readFileSync(`${PROC_PATH}/stat`, 'utf8');
    const now = Date.now();
    const timeDelta = prevTimestamp ? (now - prevTimestamp) / 1000 : 1;

    const ctxtMatch = stat.match(/ctxt\s+(\d+)/);
    const intrMatch = stat.match(/intr\s+(\d+)/);
    const procsRunning = stat.match(/procs_running\s+(\d+)/);
    const procsBlocked = stat.match(/procs_blocked\s+(\d+)/);

    const currentStats = {
      contextSwitches: ctxtMatch ? parseInt(ctxtMatch[1]) : 0,
      interrupts: intrMatch ? parseInt(intrMatch[1]) : 0,
      procsRunning: procsRunning ? parseInt(procsRunning[1]) : 0,
      procsBlocked: procsBlocked ? parseInt(procsBlocked[1]) : 0
    };

    let result = { ...currentStats };

    // Calculate rates if we have previous data
    if (prevKernelStats) {
      result.contextSwitchRate = Math.round((currentStats.contextSwitches - prevKernelStats.contextSwitches) / timeDelta);
      result.interruptRate = Math.round((currentStats.interrupts - prevKernelStats.interrupts) / timeDelta);
    } else {
      result.contextSwitchRate = 0;
      result.interruptRate = 0;
    }

    prevKernelStats = currentStats;
    return result;
  } catch (error) {
    console.error('Error getting kernel stats:', error.message);
    return null;
  }
}

/**
 * Analyze current metrics for bottlenecks
 */
function analyzeBottlenecks(metrics) {
  const issues = [];

  // Check per-core saturation
  if (metrics.perCoreCpu && metrics.perCoreCpu.length > 0) {
    const saturatedCores = metrics.perCoreCpu.filter(c => c.usage >= 90);
    if (saturatedCores.length > 0) {
      const severity = saturatedCores.some(c => c.usage >= 98) ? 'critical' : 'warning';
      issues.push({
        type: 'cpu_core_saturation',
        severity,
        cores: saturatedCores.map(c => c.core),
        maxUsage: Math.max(...saturatedCores.map(c => c.usage)),
        message: `Core(s) ${saturatedCores.map(c => c.core).join(', ')} at >90% - single-threaded bottleneck`,
        recommendation: 'A process is maxing out specific cores. Consider upgrading to CPU with higher single-core performance or parallelizing the workload.'
      });
    }
  }

  // Check I/O wait
  if (metrics.cpuExtended && metrics.cpuExtended.iowait >= 10) {
    const severity = metrics.cpuExtended.iowait >= 20 ? 'critical' : 'warning';
    issues.push({
      type: 'high_iowait',
      severity,
      value: metrics.cpuExtended.iowait,
      message: `High I/O wait: ${metrics.cpuExtended.iowait}% CPU time waiting for disk`,
      recommendation: 'Upgrade to faster storage (NVMe SSD), add more RAM for caching, or optimize disk-heavy applications.'
    });
  }

  // Check CPU steal
  if (metrics.cpuExtended && metrics.cpuExtended.steal >= 5) {
    const severity = metrics.cpuExtended.steal >= 10 ? 'critical' : 'warning';
    issues.push({
      type: 'cpu_steal',
      severity,
      value: metrics.cpuExtended.steal,
      message: `CPU steal time: ${metrics.cpuExtended.steal}% - hypervisor taking cycles`,
      recommendation: 'If virtualized, the host is overcommitted. Request dedicated CPU resources.'
    });
  }

  // Check memory pressure (swap)
  if (metrics.memoryPressure && metrics.memoryPressure.swapUsage >= 20) {
    const severity = metrics.memoryPressure.swapUsage >= 50 ? 'critical' : 'warning';
    issues.push({
      type: 'memory_pressure',
      severity,
      swapUsage: metrics.memoryPressure.swapUsage,
      message: `Memory pressure: ${metrics.memoryPressure.swapUsage}% swap in use`,
      recommendation: 'Add more RAM or reduce running services.'
    });
  }

  // Check thermal throttling
  if (metrics.cpuTemperature && metrics.cpuTemperature.celsius >= 80) {
    const severity = metrics.cpuTemperature.celsius >= 90 ? 'critical' : 'warning';
    issues.push({
      type: 'thermal_throttle',
      severity,
      temperature: metrics.cpuTemperature.celsius,
      message: `CPU at ${metrics.cpuTemperature.celsius}°C - may be throttling`,
      recommendation: severity === 'critical' ?
        'CPU is likely throttling! Improve cooling immediately.' :
        'CPU running hot. Check case airflow and cooling solution.'
    });
  }

  // Check disk latency
  for (const disk of (metrics.diskIo || [])) {
    if (disk.avgLatencyMs >= 20) {
      const severity = disk.avgLatencyMs >= 50 ? 'critical' : 'warning';
      issues.push({
        type: 'disk_latency',
        severity,
        device: disk.device,
        latency: disk.avgLatencyMs,
        message: `High disk latency on ${disk.device}: ${disk.avgLatencyMs}ms`,
        recommendation: 'Check if using SSD or HDD. Consider upgrading to NVMe storage.'
      });
    }
  }

  return issues;
}

/**
 * Get all detailed metrics in one call
 */
function getDetailedMetrics() {
  const perCoreCpu = getPerCoreCpu();
  const cpuExtended = getCpuExtended();
  const diskIo = getDiskIo();
  const memoryPressure = getMemoryPressure();
  const topProcesses = getTopProcesses();
  const cpuTemperature = getCpuTemperature();
  const kernelStats = getKernelStats();

  const metrics = {
    perCoreCpu,
    cpuExtended,
    diskIo,
    memoryPressure,
    topProcesses,
    cpuTemperature,
    kernelStats,
    timestamp: new Date().toISOString()
  };

  metrics.bottlenecks = analyzeBottlenecks(metrics);

  return metrics;
}

/**
 * Get disk usage from mounted host drives
 */
function getHostDiskUsage() {
  const disks = [];

  // Check for mounted Windows drives
  const driveLetters = ['c', 'd', 'e', 'f', 'g', 'h'];
  for (const letter of driveLetters) {
    const mountPath = `${HOST_DRIVES}/${letter}`;
    try {
      if (!fs.existsSync(mountPath)) continue;

      // Try to get disk stats using df on the mount point
      const output = execSync(`df -B1 "${mountPath}" 2>/dev/null | tail -1`, { encoding: 'utf8', timeout: 5000 });
      const parts = output.trim().split(/\s+/);

      if (parts.length >= 4) {
        const total = parseInt(parts[1]) || 0;
        const used = parseInt(parts[2]) || 0;
        const available = parseInt(parts[3]) || 0;

        if (total > 1073741824) { // Only show > 1GB drives
          disks.push({
            mount: `${letter.toUpperCase()}:`,
            filesystem: parts[0],
            total,
            used,
            available,
            usage: Math.round((used / total) * 1000) / 10,
            label: letter === 'c' ? 'System' : (letter === 'g' ? 'Storage' : '')
          });
        }
      }
    } catch (e) {
      continue;
    }
  }

  return disks;
}

/**
 * Try to get GPU info via docker socket or direct nvidia-smi
 */
function getGpuInfo() {
  // First try nvidia-smi directly (works if container has GPU passthrough)
  try {
    const output = execSync('nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
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
    if (gpus.length > 0) return gpus;
  } catch (e) {
    // nvidia-smi not available directly
  }

  // Try via docker exec on host (requires docker socket)
  try {
    const output = execSync(
      'docker run --rm --gpus all nvidia/cuda:12.0.0-base-ubuntu22.04 nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null',
      { encoding: 'utf8', timeout: 15000 }
    );
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
    if (gpus.length > 0) return gpus;
  } catch (e) {
    // Docker GPU access not available
  }

  return [];
}

// Initialize - collect baseline data
function initialize() {
  // Run once to populate previous values for rate calculations
  getPerCoreCpu();
  getDiskIo();
  getKernelStats();
}

module.exports = {
  getPerCoreCpu,
  getCpuExtended,
  getDiskIo,
  getMemoryPressure,
  getTopProcesses,
  getCpuTemperature,
  getKernelStats,
  analyzeBottlenecks,
  getDetailedMetrics,
  getHostDiskUsage,
  getGpuInfo,
  initialize
};
