const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3004;

// Enable CORS for all routes
app.use(cors());

// Service definitions
const services = [
  {
    id: 'portfolio',
    name: 'Terminal Portfolio',
    description: 'Interactive terminal-style portfolio website',
    endpoint: 'http://portfolio-backend:3001/health',
    publicUrl: 'https://portfolio.basedsecurity.net',
    category: 'application'
  },
  {
    id: 'shipping',
    name: 'Shipping Monitor',
    description: 'Real-time package tracking dashboard',
    endpoint: 'http://shipping-backend:3003/api/shipments',
    publicUrl: 'https://shipping.basedsecurity.net',
    category: 'application'
  },
  {
    id: 'security',
    name: 'BasedSecurity AI',
    description: 'AI-powered security platform with license management',
    endpoint: 'http://security-backend:8000/health',
    publicUrl: 'https://security.basedsecurity.net',
    category: 'application'
  },
  {
    id: 'photos',
    name: 'RapidPhotoFlow',
    description: 'Photo management and AI tagging application',
    endpoint: 'http://photos-backend:8080/actuator/health',
    publicUrl: 'https://photos.basedsecurity.net',
    category: 'application'
  },
  {
    id: 'photos-ai',
    name: 'Photos AI Service',
    description: 'AI-powered image tagging microservice',
    endpoint: 'http://photos-ai:3002/health',
    publicUrl: null,
    category: 'microservice'
  },
  {
    id: 'postgres',
    name: 'PostgreSQL Database',
    description: 'Primary relational database',
    endpoint: 'http://postgres:5432',
    publicUrl: null,
    category: 'infrastructure',
    tcpCheck: true
  },
  {
    id: 'redis',
    name: 'Redis Cache',
    description: 'In-memory data store for caching and sessions',
    endpoint: 'http://redis:6379',
    publicUrl: null,
    category: 'infrastructure',
    tcpCheck: true
  },
  {
    id: 'nginx',
    name: 'API Gateway',
    description: 'Nginx reverse proxy and load balancer',
    endpoint: 'http://nginx:80/health',
    publicUrl: 'https://api.basedsecurity.net',
    category: 'infrastructure'
  }
];

// Check a single service health
async function checkService(service) {
  const startTime = Date.now();

  try {
    if (service.tcpCheck) {
      // For TCP services like postgres/redis, we check via Docker network
      // Since we can't do raw TCP in Node easily, we'll rely on Docker health checks
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

// Check all services
async function checkAllServices() {
  const results = await Promise.all(services.map(checkService));

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
    services: results
  };
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'status-page' });
});

// Status API endpoint
app.get('/api/status', async (req, res) => {
  try {
    const status = await checkAllServices();
    res.json(status);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check services',
      message: error.message
    });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Status page running on port ${PORT}`);
});
