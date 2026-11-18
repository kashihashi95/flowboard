import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `npm run build:single` produces one self-contained HTML file in dist-single/.
// The regular build (and `vite preview`) uses base '/flowboard/' for GitHub Pages;
// the dev server stays at '/'.
export default defineConfig(({ command, mode, isPreview }) => ({
  base: mode === 'single' || (command === 'serve' && !isPreview) ? '/' : '/flowboard/',
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  build: mode === 'single' ? { outDir: 'dist-single' } : {},
}))
