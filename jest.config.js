module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js', '**/*.spec.js'],
  collectCoverageFrom: [
    '**/*.js',
    '!node_modules/**',
    '!coverage/**',
    '!jest.config.js',
    '!test/**',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  setupFilesAfterEnv: ['./test/setup.js'],
  testTimeout: 10000,
  verbose: true,
};
