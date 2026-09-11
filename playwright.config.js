const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
module.exports = defineConfig({
  testDir: './tests', testMatch: '*.spec.js', workers: 1,
  use: { baseURL: 'http://127.0.0.1:3100', headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  webServer: {
    command: 'node server.js', url: 'http://127.0.0.1:3100/api/health', reuseExistingServer: false,
    // The browser suite never reaches a federal API: the public-context proxy
    // is switched off so the console's refusal path is what gets exercised.
    env: {
      PORT: '3100', NODE_ENV: 'test', DATABASE_URL: '', AI_PROVIDER: 'disabled',
      FORGE_API_TOKEN: '', PUBLIC_CONTEXT_ENABLED: 'false',
      FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ui-test-')),
    },
  },
});
