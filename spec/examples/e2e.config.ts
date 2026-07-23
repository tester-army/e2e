import { defineConfig } from 'e2e';

export default defineConfig({
  app: {
    url: process.env.APP_URL ?? 'http://localhost:3000',
    command: 'pnpm dev',
  },

  targets: [
    { name: 'web', platform: 'web', browser: 'chromium' },
    { name: 'ios', platform: 'ios', app: 'ios/build/Orbit.app', device: 'iPhone 16' },
    { name: 'android', platform: 'android', app: 'android/app/build/outputs/apk/release/app-release.apk' },
  ],

  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  artifacts: ['trace', 'screenshot', 'video'],

  credentials: {
    member: { username: 'member@orbit.test', password: process.env.MEMBER_PASSWORD! },
    admin: { username: 'admin@orbit.test', password: process.env.ADMIN_PASSWORD! },
    owner: { username: 'owner@orbit.test', password: process.env.OWNER_PASSWORD! },
  },

  agent: {
    maxSteps: 25,
    cache: true,
    context: [
      'Orbit is a project-management app. "Spaces" contain "Boards" contain "Tasks".',
      'Dismiss the changelog popover if it appears after login.',
    ].join('\n'),
  },
});
