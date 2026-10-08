import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { lightpanda } from '@e2e-dev/lightpanda';

export default {
  projectId: 'dev.e2e.testbed',
  targets: [
    {
      name: 'lightpanda',
      engine: web({ browser: lightpanda({ loadResources: ['iframe'] }) }),
      app: {
        url: 'http://127.0.0.1:4271',
        command: { executable: 'node', args: ['app/server.mjs'], env: { PORT: '4271' } },
      },
    },
  ],
  credentials: {
    admin: {
      username: 'admin',
      password: 'admin-pass',
    },
  },
} satisfies E2EConfig;
