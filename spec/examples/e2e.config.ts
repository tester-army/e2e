import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.testerarmy.orbit',

  // The backend declares the app it drives: where it is served, the services
  // and command that start it, and the environment label.
  targets: [
    {
      name: 'web',
      platform: 'web',
      backend: playwright({
        browser: 'chromium',
        url: process.env.APP_URL ?? 'http://localhost:3000',
        services: [
          {
            name: 'postgres',
            executable: 'docker',
            args: ['compose', 'up', '--wait', 'postgres'],
            waitForExit: true,
            teardown: { executable: 'docker', args: ['compose', 'down'] },
          },
          { name: 'migrate', executable: 'pnpm', args: ['db:migrate'], waitForExit: true },
        ],
        command: {
          executable: 'pnpm',
          args: ['dev'],
        },
        ...(process.env.APP_ENVIRONMENT
          ? { environment: process.env.APP_ENVIRONMENT as 'test' | 'staging' | 'production' }
          : {}),
      }),
    },
  ],

  timeout: 120_000,
  artifacts: ['trace', 'screenshot'],
  cache: process.env.CI ? 'read-only' : 'read-write',

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
