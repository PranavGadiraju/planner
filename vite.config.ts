import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Planner',
        short_name: 'Planner',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f1115',
        theme_color: '#0f1115',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
        globPatterns: ['**/*.{js,css,html,png,svg,wasm,woff2}'],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
