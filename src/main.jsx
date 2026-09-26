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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary FallbackComponent={CrashHandoff}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
