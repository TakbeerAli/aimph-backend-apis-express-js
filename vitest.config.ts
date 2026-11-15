import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    // First run downloads the mongod binary; transactions can be slow on CI.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      PORT: '4000',
      // Placeholder for env validation; tests connect to the in-memory replica set instead.
      MONGODB_URI: 'mongodb://placeholder:27017/test',
      JWT_ACCESS_SECRET: 'test-access-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      ACCESS_TOKEN_TTL: '15m',
      REFRESH_TOKEN_TTL: '30d',
      CORS_ORIGINS: 'http://localhost:8081',
      TZ_BUSINESS: 'Asia/Karachi',
    },
  },
});
