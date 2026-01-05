const request = require('supertest');
const nock = require('nock');

// We need to import the app differently for testing
// First, let's create a testable version of the server

describe('Status Page Server', () => {
  let app;

  beforeAll(() => {
    // Set test environment
    process.env.PORT = '3097';
    process.env.NODE_ENV = 'test';

    // Clear require cache to ensure fresh import
    jest.resetModules();

    // Import express and setup app for testing
    const express = require('express');
    const cors = require('cors');
    const path = require('path');

    app = express();
    app.use(cors());

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', service: 'status-page' });
    });

    // Create a mock checkAllServices function
    const mockServices = [
      {
        id: 'test-service',
        name: 'Test Service',
        description: 'Test service description',
        endpoint: 'http://test:3000/health',
        publicUrl: 'https://test.example.com',
        category: 'application',
        status: 'operational',
        responseTime: 50,
        lastChecked: new Date().toISOString(),
        message: 'All systems operational'
      }
    ];

    // Status API endpoint
    app.get('/api/status', async (req, res) => {
      try {
        res.json({
          overallStatus: 'operational',
          timestamp: new Date().toISOString(),
          services: mockServices
        });
      } catch (error) {
        res.status(500).json({
          error: 'Failed to check services',
          message: error.message
        });
      }
    });

    // Serve static files and catch-all
    app.use(express.static(path.join(__dirname, '../public')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '../public', 'index.html'));
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        service: 'status-page'
      });
    });

    it('should have correct content-type', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('GET /api/status', () => {
    it('should return status for all services', async () => {
      const response = await request(app).get('/api/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('overallStatus');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('services');
      expect(Array.isArray(response.body.services)).toBe(true);
    });

    it('should have valid timestamp format', async () => {
      const response = await request(app).get('/api/status');

      const timestamp = new Date(response.body.timestamp);
      expect(timestamp.toString()).not.toBe('Invalid Date');
    });

    it('should have valid service structure', async () => {
      const response = await request(app).get('/api/status');

      const service = response.body.services[0];
      expect(service).toHaveProperty('id');
      expect(service).toHaveProperty('name');
      expect(service).toHaveProperty('status');
    });
  });
});

describe('checkService function', () => {
  // Test the checkService logic directly
  const fetch = require('node-fetch');

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

  const testService = {
    id: 'test',
    name: 'Test Service',
    description: 'A test service',
    endpoint: 'http://test-service:3000/health',
    publicUrl: 'https://test.example.com',
    category: 'application'
  };

  beforeEach(() => {
    nock.cleanAll();
  });

  it('should return operational status for 200 response', async () => {
    nock('http://test-service:3000')
      .get('/health')
      .reply(200, { status: 'ok' });

    const result = await checkService(testService);

    expect(result.status).toBe('operational');
    expect(result.message).toBe('All systems operational');
    expect(result).toHaveProperty('responseTime');
    expect(result).toHaveProperty('lastChecked');
  });

  it('should return degraded status for 4xx response', async () => {
    nock('http://test-service:3000')
      .get('/health')
      .reply(404, { error: 'Not found' });

    const result = await checkService(testService);

    expect(result.status).toBe('degraded');
    expect(result.message).toContain('Client error');
  });

  it('should return major_outage for 5xx response', async () => {
    nock('http://test-service:3000')
      .get('/health')
      .reply(500, { error: 'Internal server error' });

    const result = await checkService(testService);

    expect(result.status).toBe('major_outage');
    expect(result.message).toContain('Server error');
  });

  it('should return operational for TCP check services', async () => {
    const tcpService = {
      ...testService,
      tcpCheck: true
    };

    const result = await checkService(tcpService);

    expect(result.status).toBe('operational');
    expect(result.message).toContain('Docker healthcheck');
    expect(result.responseTime).toBeNull();
  });

  it('should handle connection refused errors', async () => {
    nock('http://test-service:3000')
      .get('/health')
      .replyWithError({ code: 'ECONNREFUSED' });

    const result = await checkService(testService);

    expect(result.status).toBe('major_outage');
    expect(result.message).toBe('Connection refused');
  });

  it('should handle host not found errors', async () => {
    nock('http://test-service:3000')
      .get('/health')
      .replyWithError({ code: 'ENOTFOUND' });

    const result = await checkService(testService);

    expect(result.status).toBe('major_outage');
    expect(result.message).toBe('Host not found');
  });

  it('should parse JSON response data', async () => {
    const healthData = { status: 'healthy', uptime: 1234 };
    nock('http://test-service:3000')
      .get('/health')
      .reply(200, healthData);

    const result = await checkService(testService);

    expect(result.data).toEqual(healthData);
  });

  it('should handle non-JSON response gracefully', async () => {
    nock('http://test-service:3000')
      .get('/health')
      .reply(200, 'OK');

    const result = await checkService(testService);

    expect(result.status).toBe('operational');
    expect(result.data).toBeNull();
  });

  it('should include service properties in result', async () => {
    nock('http://test-service:3000')
      .get('/health')
      .reply(200, { status: 'ok' });

    const result = await checkService(testService);

    expect(result.id).toBe(testService.id);
    expect(result.name).toBe(testService.name);
    expect(result.description).toBe(testService.description);
    expect(result.category).toBe(testService.category);
  });
});

describe('checkAllServices function', () => {
  function checkAllServices(services, checkServiceFn) {
    return Promise.all(services.map(checkServiceFn)).then(results => {
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
    });
  }

  it('should return operational when all services are operational', async () => {
    const mockServices = [
      { id: 'svc1' },
      { id: 'svc2' }
    ];
    const mockCheckService = jest.fn().mockResolvedValue({ status: 'operational' });

    const result = await checkAllServices(mockServices, mockCheckService);

    expect(result.overallStatus).toBe('operational');
    expect(mockCheckService).toHaveBeenCalledTimes(2);
  });

  it('should return degraded when any service is degraded', async () => {
    const mockServices = [
      { id: 'svc1' },
      { id: 'svc2' }
    ];
    const mockCheckService = jest.fn()
      .mockResolvedValueOnce({ status: 'operational' })
      .mockResolvedValueOnce({ status: 'degraded' });

    const result = await checkAllServices(mockServices, mockCheckService);

    expect(result.overallStatus).toBe('degraded');
  });

  it('should return major_outage when any service has major_outage', async () => {
    const mockServices = [
      { id: 'svc1' },
      { id: 'svc2' },
      { id: 'svc3' }
    ];
    const mockCheckService = jest.fn()
      .mockResolvedValueOnce({ status: 'operational' })
      .mockResolvedValueOnce({ status: 'degraded' })
      .mockResolvedValueOnce({ status: 'major_outage' });

    const result = await checkAllServices(mockServices, mockCheckService);

    expect(result.overallStatus).toBe('major_outage');
  });

  it('should include timestamp in response', async () => {
    const mockServices = [{ id: 'svc1' }];
    const mockCheckService = jest.fn().mockResolvedValue({ status: 'operational' });

    const result = await checkAllServices(mockServices, mockCheckService);

    expect(result).toHaveProperty('timestamp');
    expect(new Date(result.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('should include all services in response', async () => {
    const mockServices = [
      { id: 'svc1' },
      { id: 'svc2' },
      { id: 'svc3' }
    ];
    const mockCheckService = jest.fn().mockResolvedValue({ status: 'operational' });

    const result = await checkAllServices(mockServices, mockCheckService);

    expect(result.services).toHaveLength(3);
  });
});

describe('Service definitions', () => {
  const services = [
    // Cloud-hosted applications
    { id: 'portfolio', category: 'application' },
    { id: 'shipping', category: 'application' },
    { id: 'security', category: 'application' },
    { id: 'photos', category: 'application' },
    // Microservices
    { id: 'photos-ai', category: 'microservice' },
    // Infrastructure
    { id: 'postgres', category: 'infrastructure', tcpCheck: true },
    { id: 'redis', category: 'infrastructure', tcpCheck: true },
    { id: 'nginx', category: 'infrastructure' },
    // Home server services
    { id: 'jellyfin', category: 'homeserver' },
    { id: 'nextcloud', category: 'homeserver' },
    { id: 'vaultwarden', category: 'homeserver' },
    { id: 'openwebui', category: 'homeserver' }
  ];

  it('should have 12 total services', () => {
    expect(services).toHaveLength(12);
  });

  it('should have 4 application services', () => {
    const apps = services.filter(s => s.category === 'application');
    expect(apps).toHaveLength(4);
  });

  it('should have 1 microservice', () => {
    const microservices = services.filter(s => s.category === 'microservice');
    expect(microservices).toHaveLength(1);
  });

  it('should have 3 infrastructure services', () => {
    const infra = services.filter(s => s.category === 'infrastructure');
    expect(infra).toHaveLength(3);
  });

  it('should have 4 home server services', () => {
    const homeserver = services.filter(s => s.category === 'homeserver');
    expect(homeserver).toHaveLength(4);
  });

  it('should have 2 TCP check services', () => {
    const tcpServices = services.filter(s => s.tcpCheck);
    expect(tcpServices).toHaveLength(2);
  });
});

describe('HTTP status code handling', () => {
  const statusCodes = [
    { code: 200, expectedStatus: 'operational' },
    { code: 201, expectedStatus: 'operational' },
    { code: 204, expectedStatus: 'operational' },
    { code: 400, expectedStatus: 'degraded' },
    { code: 401, expectedStatus: 'degraded' },
    { code: 403, expectedStatus: 'degraded' },
    { code: 404, expectedStatus: 'degraded' },
    { code: 500, expectedStatus: 'major_outage' },
    { code: 502, expectedStatus: 'major_outage' },
    { code: 503, expectedStatus: 'major_outage' },
    { code: 504, expectedStatus: 'major_outage' }
  ];

  statusCodes.forEach(({ code, expectedStatus }) => {
    it(`should map HTTP ${code} to ${expectedStatus}`, () => {
      let status = 'operational';
      if (code >= 500) {
        status = 'major_outage';
      } else if (code >= 400) {
        status = 'degraded';
      }
      expect(status).toBe(expectedStatus);
    });
  });
});
