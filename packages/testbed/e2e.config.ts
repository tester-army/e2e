import { defineConfig } from 'e2e';

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed',
  app: {
    url: 'http://127.0.0.1:4271',
    command: {
      executable: 'node',
      args: ['app/server.mjs'],
      env: { PORT: '4271' },
    },
  },
  targets: [{ name: 'web', platform: 'web', browser: 'chromium' }],
  credentials: {
    admin: {
      username: 'admin',
      password: 'admin-pass',
    },
  },
});
