import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed',
  targets: [
    {
      name: 'web',
      platform: 'web',
      backend: playwright({
        url: 'http://127.0.0.1:4271',
        command: { executable: 'node', args: ['app/server.mjs'], env: { PORT: '4271' } },
      }),
    },
  ],
  credentials: {
    admin: {
      username: 'admin',
      password: 'admin-pass',
    },
  },
});
