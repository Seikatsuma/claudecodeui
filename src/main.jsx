import React from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Initialize i18n
import './i18n/config.js'

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

// Падение программы вне окна чата раньше снимало с экрана всё — оставался
// белый лист (25.09.26). Теперь падение уходит страховке из index.html: она
// пишет причину в журнал службы, перезапускает страницу, а после двух неудач
// показывает экран с кнопками.
function CrashHandoff({ error }) {
  React.useEffect(() => {
    const guard = window.__bootGuard
    const message = String((error && (error.stack || error.message)) || error).slice(0, 600)
    if (!guard) return
    guard.errors.push('программа упала: ' + message)
    guard.recover('программа упала: ' + String((error && error.message) || error).slice(0, 160))
  }, [error])
  return null
}

// Стили программы подключаются, не держа первый кадр (vite.config.js,
// non-blocking-app-css, 01.10.26): пока они в дороге, видна заставка.
// Рисовать программу раньше стилей нельзя — она мигнёт голой разметкой.
// Стиль не пришёл — решает страховка из index.html (перезапуск, потом
// экран с кнопками), а не программа без оформления.
function whenAppCssReady() {
  const pending = [...document.querySelectorAll('link[data-app-css]')].filter(link => link.media !== 'all')
  if (pending.length === 0) return Promise.resolve()
  return new Promise(resolve => {
    let left = pending.length
    pending.forEach(link => {
      link.addEventListener('load', () => { if (--left === 0) resolve() }, { once: true })
      link.addEventListener('error', () => {
        const guard = window.__bootGuard
        if (guard && guard.recover) guard.recover('не загрузился файл стилей ' + link.getAttribute('href'))
        else resolve()
      }, { once: true })
    })
  })
}

whenAppCssReady().then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ErrorBoundary FallbackComponent={CrashHandoff}>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  )
})
