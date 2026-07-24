import { defineConfig } from 'e2e';

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.testerarmy.orbit',
  app: {
    url: process.env.APP_URL ?? 'http://localhost:3000',
    command: {
      executable: 'pnpm',
      args: ['dev'],
    },
    ...(process.env.APP_ENVIRONMENT
      ? { environment: process.env.APP_ENVIRONMENT as 'test' | 'staging' | 'production' }
      : {}),
  },

  targets: [
    { name: 'web', platform: 'web', browser: 'chromium' },
  ],

  timeout: 120_000,
  artifacts: ['trace', 'screenshot', 'video'],

  credentials: {
    member: { username: 'member@orbit.test', password: process.env.MEMBER_PASSWORD! },
    admin: { username: 'admin@orbit.test', password: process.env.ADMIN_PASSWORD! },
  },

  agent: {
    ...(process.env.E2E_MODEL ? { model: process.env.E2E_MODEL } : {}),
    maxSteps: 25,
    context: [
      'Orbit is a project-management app. "Spaces" contain "Boards" contain "Tasks".',
      'Dismiss the changelog popover if it appears after login.',
    ].join('\n'),
  },
});
