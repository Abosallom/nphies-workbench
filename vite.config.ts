import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base must match the GitHub Pages repo path (github.com/Abosallom/ISIT)
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/ISIT/' : '/',
  plugins: [react(), tailwindcss()],
})
