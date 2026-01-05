const nock = require('nock');

// Disable real HTTP requests in tests
beforeAll(() => {
  nock.disableNetConnect();
  // Allow localhost for supertest
  nock.enableNetConnect('127.0.0.1');
});

// Clean up nock after each test
afterEach(() => {
  nock.cleanAll();
});

// Re-enable connections after tests
afterAll(() => {
  nock.enableNetConnect();
});

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '3097';

// Mock console to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
