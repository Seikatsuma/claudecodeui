import { BrowserView } from 'electron';

const TARGET_LOAD_TIMEOUT_MS = 20000;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Экран ожидания: спокойная надпись по-русски. Технический журнал запуска
// человеку не показываем — он есть в «Сведениях для поддержки» (меню программы).
// Показываем только строки с ошибкой, если запуск упал.
function buildPlaceholderHtml(title, message, logs = []) {
  const errors = logs
    .filter((line) => /error|ошибк|exited with code [1-9]|failed/i.test(line))
    .filter((line) => !/No \.env file found/.test(line)) // сервер программы работает без .env — это не ошибка
    .slice(-6);
  return [
    '<!doctype html><meta charset="utf-8">',
    '<style>',
    'html,body{margin:0;height:100%;background:#141414;color:#ececea;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    'body{display:flex;align-items:center;justify-content:center}',
    '.box{display:flex;flex-direction:column;align-items:center;gap:16px;max-width:560px;padding:24px;text-align:center}',
    '.spin{width:28px;height:28px;border-radius:50%;border:3px solid #333;border-top-color:#4f8ef7;animation:s 0.9s linear infinite}',
    '@keyframes s{to{transform:rotate(360deg)}}',
    '.sub{color:#8f8f8a;font-size:13px}',
    'pre{margin:8px 0 0;text-align:left;max-width:100%;overflow:auto;background:#0b0b0b;border:1px solid #2a2a2a;border-radius:8px;padding:10px;color:#e0a0a0;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap}',
    '</style>',
    '<div class="box"><div class="spin"></div>',
    `<div>${escapeHtml(message || `Открываю ${title}…`)}</div>`,
    '<div class="sub">Обычно это несколько секунд.</div>',
    errors.length ? `<pre>${errors.map(escapeHtml).join('\n')}</pre>` : '',
    '</div>',
  ].join('');
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function loadUrlWithTimeout(webContents, url, timeoutMs = TARGET_LOAD_TIMEOUT_MS) {
  let timedOut = false;
  let timeout = null;
  const loadPromise = webContents.loadURL(url);
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        webContents.stop();
      } catch {
        // Ignore teardown races while reporting the original timeout.
      }
      reject(new Error(`Timed out loading ${url} after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
  });

  try {
    await Promise.race([loadPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      loadPromise.catch(() => {});
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ViewHost {
  constructor({ appName, getMainWindow, getContentViewBounds, getPreloadPath, openExternalUrl, showError }) {
    this.appName = appName;
    this.getMainWindow = getMainWindow;
    this.getContentViewBounds = getContentViewBounds;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.showError = showError;
    this.activeContentView = null;
    this.tabViews = new Map();
  }

  configureChildWebContents(webContents) {
    webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalUrl(url).catch((error) => this.showError('Could not open external link', error));
      return { action: 'deny' };
    });
  }

  detachAll() {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      for (const view of mainWindow.getBrowserViews()) {
        mainWindow.removeBrowserView(view);
      }
    } catch {
      // BrowserViews may already be gone during BrowserWindow teardown.
    }
    this.activeContentView = null;
  }

  detachActiveView() {
    const mainWindow = this.getMainWindow();
    const view = this.activeContentView;
    if (!mainWindow || mainWindow.isDestroyed() || !view) return false;
    try {
      if (mainWindow.getBrowserViews().includes(view)) {
        mainWindow.removeBrowserView(view);
      }
    } catch {
      return false;
    }
    this.activeContentView = null;
    return true;
  }

  getActiveView() {
    const view = this.activeContentView;
    if (!view || view.webContents.isDestroyed()) return null;
    return view;
  }

  openActiveViewDevTools() {
    const view = this.getActiveView();
    if (!view) return false;
    view.webContents.openDevTools({ mode: 'detach' });
    return true;
  }

  reloadActiveView() {
    const view = this.getActiveView();
    if (!view) return false;
    view.webContents.reloadIgnoringCache();
    return true;
  }

  async readLocalStorageValueForOrigin(originUrl, key) {
    let targetOrigin;
    try {
      targetOrigin = new URL(originUrl).origin;
    } catch {
      return null;
    }

    for (const view of this.tabViews.values()) {
      if (!view || view.webContents.isDestroyed()) continue;
      let viewOrigin;
      try {
        viewOrigin = new URL(view.webContents.getURL()).origin;
      } catch {
        continue;
      }
      if (viewOrigin !== targetOrigin) continue;

      try {
        const value = await view.webContents.executeJavaScript(
          `window.localStorage.getItem(${JSON.stringify(key)})`,
          true
        );
        return typeof value === 'string' && value ? value : null;
      } catch {
        return null;
      }
    }

    return null;
  }

  getTabViewDiagnostics() {
    const mainWindow = this.getMainWindow();
    const attachedViews = new Set();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        for (const view of mainWindow.getBrowserViews()) {
          attachedViews.add(view);
        }
      } catch {
        // Ignore teardown races while gathering best-effort diagnostics.
      }
    }

    return Array.from(this.tabViews.entries()).map(([tabId, view]) => {
      const { webContents } = view;
      const destroyed = webContents.isDestroyed();
      return {
        tabId,
        webContentsId: destroyed ? null : webContents.id,
        url: destroyed ? null : webContents.getURL(),
        title: destroyed ? null : webContents.getTitle(),
        osProcessId: destroyed || typeof webContents.getOSProcessId !== 'function' ? null : webContents.getOSProcessId(),
        processId: destroyed || typeof webContents.getProcessId !== 'function' ? null : webContents.getProcessId(),
        attached: attachedViews.has(view),
        active: this.activeContentView === view,
        destroyed,
      };
    });
  }

  getOrCreateTabView(tabId) {
    let view = this.tabViews.get(tabId);
    if (view) return view;

    view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });
    this.configureChildWebContents(view.webContents);
    this.tabViews.set(tabId, view);
    return view;
  }

  attach(view) {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (this.activeContentView && this.activeContentView !== view) {
      this.detachAll();
    }
    this.activeContentView = view;
    try {
      if (!mainWindow.getBrowserViews().includes(view)) {
        mainWindow.addBrowserView(view);
      }
    } catch {
      return;
    }
    // Размер задаёт только resizeActiveView по событиям окна. Вместе с
    // setAutoResize страница сжималась дважды (окно −200 → страница −400)
    // и из-под неё торчал стартовый экран.
    view.setBounds(this.getContentViewBounds());
  }

  resizeActiveView() {
    if (this.activeContentView) {
      this.activeContentView.setBounds(this.getContentViewBounds());
    }
  }

  async showTabPlaceholder(tabId, target, message) {
    const view = this.getOrCreateTabView(tabId);
    this.attach(view);
    const html = buildPlaceholderHtml(target.name || this.appName, message);
    await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    view.__cloudcliStartupHtml = html;
    view.__cloudcliLoadedUrl = null;
  }

  async showLocalStartupTarget(tabId, target, logs) {
    const view = this.getOrCreateTabView(tabId);
    if (view.__cloudcliLoadingUrl) return;
    this.attach(view);
    const html = buildPlaceholderHtml(target.name || this.appName, 'Запускаю Claude UI на этом компьютере…', logs);
    if (view.__cloudcliStartupHtml === html) return;
    await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    view.__cloudcliStartupHtml = html;
    view.__cloudcliLoadedUrl = null;
  }

  async showContentTarget(tabId, target) {
    const loadUrl = target.loadUrl || target.url;
    if (!isHttpUrl(loadUrl)) {
      throw new Error(`Refusing to load unsupported app URL: ${loadUrl}`);
    }
    const view = this.getOrCreateTabView(tabId);
    this.attach(view);
    if (target.forceLoad || view.__cloudcliLoadedUrl !== target.url) {
      view.__cloudcliLoadingUrl = loadUrl;
      try {
        await loadUrlWithTimeout(view.webContents, loadUrl);
        view.__cloudcliLoadedUrl = target.url;
        view.__cloudcliStartupHtml = null;
        delete target.loadUrl;
        delete target.forceLoad;
      } finally {
        if (view.__cloudcliLoadingUrl === loadUrl) {
          view.__cloudcliLoadingUrl = null;
        }
      }
    }
    return view.webContents.getURL();
  }

  reloadTab(tabId) {
    const view = this.tabViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return false;
    view.webContents.reloadIgnoringCache();
    return true;
  }

  async navigateActiveView(url) {
    const view = this.getActiveView();
    if (!view) return false;
    await loadUrlWithTimeout(view.webContents, url);
    view.__cloudcliLoadedUrl = url;
    view.__cloudcliStartupHtml = null;
    return true;
  }

  destroyTabView(tabId) {
    const view = this.tabViews.get(tabId);
    if (!view) return;
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        if (mainWindow.getBrowserViews().includes(view)) {
          mainWindow.removeBrowserView(view);
        }
      } catch {
        // Ignore teardown races; Electron owns final destruction during quit.
      }
    }
    if (this.activeContentView === view) {
      this.activeContentView = null;
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.destroy();
      }
    } catch {
      // The view may already be destroyed by its parent BrowserWindow.
    }
    this.tabViews.delete(tabId);
  }

  clear() {
    this.tabViews.clear();
    this.activeContentView = null;
  }
}
