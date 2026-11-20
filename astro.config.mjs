// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// WebPC is mounted at /pc/ on the host site. Keep every emitted file under /pc/ (plus the
// /third-party/ notices) so the host can copy dist/pc and dist/third-party in as they are.
export default defineConfig({
  vite: { plugins: [tailwindcss()] },
  build: { inlineStylesheets: 'auto', assets: 'pc/_astro' },
});
