// Deep-merged on top of e2e.config.ts only when running with --cloud.
import { defineConfig } from 'e2e';

export default defineConfig({
  project: 'orbit',
  token: process.env.TESTERARMY_TOKEN,
  workers: 8,
});
