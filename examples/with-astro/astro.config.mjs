import { defineConfig } from 'astro/config';

export default defineConfig({
  // A fixed port, so e2e.config.ts knows where the app is.
  server: { port: 4321 },
  vite: { server: { strictPort: true } },
  // The dev toolbar would cover the footer in screenshots and add nodes the agent reads.
  devToolbar: { enabled: false },
});
