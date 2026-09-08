import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, resolveBindHost } from './shared/networkHosts.js'

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // Bind to a literal address, not the hostname 'localhost': Node resolves
  // hostnames via DNS and binds only the first address returned, which can
  // be the IPv6 loopback only (see resolveBindHost) - breaking an explicit
  // HOST=127.0.0.1 and any IPv4-only reverse proxy in front of it. Wildcard
  // hosts ('0.0.0.0'/'::') and other literals pass through unchanged so the
  // vite server still EXPOSEs all interfaces when requested.
  const host = resolveBindHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  const isOpenRegistration = env.OPEN_REGISTRATION === 'true'

  return {
    plugins: [
      react(),
      // On the shared/OPEN_REGISTRATION instance, each user's actual "app"
      // is their personal /enter/<token> magic link, not a single fixed
      // account - so the PWA manifest's start_url (always a fixed "/", see
      // public/manifest.json) is actively wrong for "Add to Home Screen":
      // iOS treats a page with a standalone-display manifest as a real
      // installable app and launches the home-screen icon at that fixed
      // start_url from then on, discarding whatever URL was on screen at
      // install time. That silently drops the token, landing on a
      // logged-out "/" and showing the invitation-only screen. Removing the
      // manifest link here makes "Add to Home Screen" fall back to the
      // older, simpler behavior of bookmarking whatever URL is actually on
      // screen (the user's own /enter/<token> link) - correct for this
      // instance, at the cost of the standalone full-screen app chrome.
      // Account 1/2 (single fixed account, no per-user token) keep the
      // manifest exactly as before.
      isOpenRegistration && {
        name: 'strip-manifest-link-on-open-registration',
        transformIndexHtml(html) {
          return html.replace(/\s*<link rel="manifest"[^>]*\/?>\n?/, '\n')
        },
      },
    ].filter(Boolean),
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      // CSS minification has been a consistent extra memory/CPU cost during
      // the exact "rendering chunks"/final-bundle step where builds on this
      // VPS have been getting killed under real contention from other
      // concurrent processes. CSS is a tiny fraction of total bundle size
      // compared to JS, so skipping just its minification is a low-cost way
      // to shave the build's peak memory footprint. JS still gets minified.
      cssMinify: !isOpenRegistration,
      // The gzip-size report is purely a terminal print, not something the
      // deployed app needs - but computing it requires holding the full
      // compressed bundle in memory on top of everything else, and on this
      // project's 3.8GB-RAM VPS that final step is exactly where builds have
      // been getting OOM-killed under real-world memory pressure (other
      // concurrent sessions/bots). Skipping it removes that peak.
      reportCompressedSize: false,
      rollupOptions: {
        output: {
          // Редактор кода и терминал намеренно НЕ вынесены в именованные
          // куски. Именованный кусок становится частью стартовой загрузки
          // страницы, даже если пользуется им только вкладка, которую ещё не
          // открыли: браузер честно скачивал и разбирал мегабайт редактора и
          // терминала при каждом входе. Без этого списка Rollup кладёт их в
          // те отложенные куски, которые их и вызывают.
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom']
          }
        }
      }
    }
  }
})
