import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Builds the report page (`app/`) into one HTML file, scripts, styles, and
 * fonts inlined, at `dist/app/index.html`. The reporter fills its payload
 * placeholder per run, so the page needs no server and fetches nothing.
 */
export default defineConfig({
  root: 'app',
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: '../dist/app',
    emptyOutDir: true,
  },
});
