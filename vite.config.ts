import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `npm run build:single` produces one self-contained HTML file in dist-single/;
// GitHub Pages serves it, so Export → HTML (a copy of the page) carries the whole app.
// The regular build (and `vite preview`) uses base '/flowboard/'; the dev server stays at '/'.
export default defineConfig(({ command, mode, isPreview }) => ({
  base: mode === 'single' || (command === 'serve' && !isPreview) ? '/' : '/flowboard/',
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  build: mode === 'single' ? { outDir: 'dist-single' } : {},
  // Which build this is, for Help → Check for updates. The Pages deploy writes the
  // same values to version.json; local builds are "dev".
  define: {
    __FLOWBOARD_VERSION__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? 'dev'),
    __FLOWBOARD_BUILT__: JSON.stringify(process.env.FLOWBOARD_BUILT ?? new Date().toISOString().slice(0, 10)),
  },
}))
