import { BrowserWindow, Menu, Tray, clipboard, nativeImage, nativeTheme, session, webContents as electronWebContents } from 'electron';

import { ViewHost } from './viewHost.js';

const TITLEBAR_HEIGHT = 44;
const AUTH_TOKEN_STORAGE_KEY = 'auth-token';
function isAllowedPermissionOrigin(sourceUrl, controlPlaneUrl) {
  try {
    const source = new URL(sourceUrl);
    if ((source.hostname === '127.0.0.1' || source.hostname === 'localhost') && source.protocol === 'http:') {
      return true;
    }
    if (source.protocol !== 'https:') {
      return false;
    }
    const controlPlane = new URL(controlPlaneUrl);
    return source.origin === controlPlane.origin || source.hostname.endsWith('.cloudcli.ai');
  } catch {
    return false;
  }
}

function getWebContentsProcessId(contents) {
  return {
    osProcessId: typeof contents.getOSProcessId === 'function' ? contents.getOSProcessId() : null,
    processId: typeof contents.getProcessId === 'function' ? contents.getProcessId() : null,
  };
}

export class DesktopWindowManager {
  constructor({
    appName,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getDesktopState,
    getDisplayTargetName,
    getRemoteEnvironmentMenuItems,
    getCloudState,
    getLocalState,
    actions,
    tabs,
  }) {
    this.appName = appName;
    this.getWindowIconPath = getWindowIconPath;
    this.getLauncherPath = getLauncherPath;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.getDesktopState = getDesktopState;
    this.getDisplayTargetName = getDisplayTargetName;
    this.getRemoteEnvironmentMenuItems = getRemoteEnvironmentMenuItems;
    this.getCloudState = getCloudState;
    this.getLocalState = getLocalState;
    this.actions = actions;
    this.tabs = tabs;

    this.mainWindow = null;
    this.settingsWindow = null;
    this.tray = null;
    this.launcherLoaded = false;
    this.viewHost = new ViewHost({
      appName: this.appName,
      getMainWindow: () => this.mainWindow,
      getContentViewBounds: () => this.getContentViewBounds(),
      getPreloadPath: this.getPreloadPath,
      openExternalUrl: this.openExternalUrl,
      showError: this.actions.showError,
    });
  }

  getMainWindow() {
    return this.mainWindow;
  }

  getTrayImage() {
    const image = nativeImage.createFromPath(this.getWindowIconPath());
    return image.resize({ width: 18, height: 18 });
  }

  getContentViewBounds() {
    if (!this.mainWindow) return { x: 0, y: TITLEBAR_HEIGHT, width: 0, height: 0 };
    const [width, height] = this.mainWindow.getContentSize();
    return {
      x: 0,
      y: TITLEBAR_HEIGHT,
      width,
      height: Math.max(0, height - TITLEBAR_HEIGHT),
    };
  }

  detachActiveContentView() {
    this.viewHost.detachAll();
  }

  async showTabPlaceholder(target, message) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showTabPlaceholder(tabId, target, message);
  }

  async showLocalStartupTarget(target, logs) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showLocalStartupTarget(tabId, target, logs);
  }

  async showContentTarget(target) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showContentTarget(tabId, target);
  }

  destroyTabView(tabId) {
    this.viewHost.destroyTabView(tabId);
  }

  emitDesktopState() {
    const state = this.getDesktopState();
    if (this.mainWindow && !this.mainWindow.webContents.isDestroyed()) {
      this.mainWindow.webContents.send('cloudcli-desktop:state-updated', state);
    }
    if (this.settingsWindow && !this.settingsWindow.webContents.isDestroyed()) {
      this.settingsWindow.webContents.send('cloudcli-desktop:state-updated', state);
    }
  }

  emitLauncherCommand(command) {
    if (!this.mainWindow || this.mainWindow.webContents.isDestroyed()) return;
    this.mainWindow.webContents.send('cloudcli-desktop:launcher-command', command);
  }

  emitSettingsCommand(command) {
    if (!this.settingsWindow || this.settingsWindow.webContents.isDestroyed()) return;
    this.settingsWindow.webContents.send('cloudcli-desktop:launcher-command', command);
  }

  syncSettingsWindowBounds() {
    if (!this.mainWindow || !this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.setBounds(this.mainWindow.getBounds());
  }

  async ensureSettingsWindow(sheet = 'desktop-settings') {
    if (!this.mainWindow) return null;

    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.syncSettingsWindowBounds();
      this.emitSettingsCommand({ type: 'open-sheet', sheet });
      this.settingsWindow.focus();
      return this.settingsWindow;
    }

    this.settingsWindow = new BrowserWindow({
      parent: this.mainWindow,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      movable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });
    this.syncSettingsWindowBounds();
    this.viewHost.configureChildWebContents(this.settingsWindow.webContents);
    this.settingsWindow.once('ready-to-show', () => this.settingsWindow?.show());
    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
    });
    await this.settingsWindow.loadFile(this.getLauncherPath(), {
      query: { modal: '1', sheet },
    });
    return this.settingsWindow;
  }

  closeSettingsWindow() {
    if (!this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.close();
  }

  async showTarget(target, { trackTab = true } = {}) {
    if (!this.mainWindow) return;
    if (trackTab) {
      this.tabs.upsertTarget(target);
    }
    this.actions.setActiveTarget(target);
    this.buildAppMenu();
    this.mainWindow.setTitle(`${this.appName} - ${target.name}`);
    const finalUrl = await this.showContentTarget(target);
    this.emitDesktopState();
    return finalUrl;
  }

  async showLauncher() {
    if (!this.mainWindow) return;
    const target = { kind: 'launcher', name: this.appName, url: null };
    this.tabs.upsertTarget(target);
    this.actions.setActiveTarget(target);
    this.detachActiveContentView();
    this.buildAppMenu();
    this.mainWindow.setTitle(this.appName);
    this.mainWindow.webContents.focus();
    if (!this.launcherLoaded) {
      await this.mainWindow.loadFile(this.getLauncherPath());
      this.launcherLoaded = true;
    } else {
      this.emitDesktopState();
    }
  }

  async switchDesktopTab(tabId) {
    const tab = this.tabs.activate(tabId);
    if (!tab || !this.mainWindow) return this.getDesktopState();

    if (tab.id === 'home' || tab.kind === 'launcher') {
      await this.showLauncher();
      return this.getDesktopState();
    }

    if (!tab.target?.url) {
      throw new Error('This tab does not have a target URL.');
    }

    await this.showTarget(tab.target, { trackTab: false });
    return this.getDesktopState();
  }

  async reloadActiveTab() {
    const activeTab = this.tabs.getActiveTab();
    if (!activeTab || activeTab.id === 'home' || activeTab.kind === 'launcher') {
      this.emitDesktopState();
      return this.getDesktopState();
    }

    const reloaded = this.viewHost.reloadTab(activeTab.id);
    if (!reloaded && activeTab.target?.url) {
      await this.showTarget(activeTab.target, { trackTab: false });
    }
    this.emitDesktopState();
    return this.getDesktopState();
  }

  async navigateActiveView(url) {
    const navigated = await this.viewHost.navigateActiveView(url);
    this.emitDesktopState();
    return navigated;
  }

  async readAuthTokenForTarget(url) {
    return this.viewHost.readLocalStorageValueForOrigin(url, AUTH_TOKEN_STORAGE_KEY);
  }

  openActiveTabDevTools() {
    if (this.viewHost.openActiveViewDevTools()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before opening active tab DevTools.'));
  }

  reloadActiveBrowserViewForDiagnostics() {
    if (this.viewHost.reloadActiveView()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before reloading the active BrowserView.'));
  }

  detachActiveBrowserViewForDiagnostics() {
    if (this.viewHost.detachActiveView()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before detaching the active BrowserView.'));
  }

  copyWebContentsDiagnostics() {
    const tabViewDiagnostics = this.viewHost.getTabViewDiagnostics();
    const tabViewByContentsId = new Map(
      tabViewDiagnostics
        .filter((item) => item.webContentsId != null)
        .map((item) => [item.webContentsId, item])
    );

    const rows = electronWebContents.getAllWebContents().map((contents) => {
      const destroyed = contents.isDestroyed();
      const processIds = destroyed ? { osProcessId: null, processId: null } : getWebContentsProcessId(contents);
      const tabView = tabViewByContentsId.get(contents.id);
      let owner = 'unknown';
      if (this.mainWindow?.webContents?.id === contents.id) {
        owner = 'main-window';
      } else if (this.settingsWindow?.webContents?.id === contents.id) {
        owner = 'settings-window';
      } else if (tabView) {
        owner = `browser-view:${tabView.tabId}`;
      }

      return {
        id: contents.id,
        owner,
        osProcessId: processIds.osProcessId,
        processId: processIds.processId,
        url: destroyed ? null : contents.getURL(),
        title: destroyed ? null : contents.getTitle(),
        destroyed,
        focused: destroyed || typeof contents.isFocused !== 'function' ? false : contents.isFocused(),
        attached: tabView ? tabView.attached : null,
        active: tabView ? tabView.active : null,
      };
    });

    const activeTab = this.tabs.getActiveTab();
    const diagnostics = {
      generatedAt: new Date().toISOString(),
      activeTabId: this.tabs.activeTabId,
      activeTab: activeTab
        ? {
            id: activeTab.id,
            title: activeTab.title,
            kind: activeTab.kind,
            targetUrl: activeTab.target?.url || null,
          }
        : null,
      tabViews: tabViewDiagnostics,
      webContents: rows,
    };

    clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  }

  async closeDesktopTab(tabId) {
    const tab = this.tabs.remove(tabId);
    if (!tab) return this.getDesktopState();
    this.destroyTabView(tabId);
    if (this.tabs.activeTabId === 'home') {
      await this.showLauncher();
    } else {
      this.emitDesktopState();
    }
    return this.getDesktopState();
  }

  // Свои серверы всегда работают: только открыть здесь, в браузере или скопировать адрес.
  buildEnvironmentActionsSubmenu(environment) {
    const name = environment.name || environment.subdomain;
    return [
      {
        label: 'Открыть',
        click: () => void this.actions.openEnvironmentInDesktop(environment)
          .catch((error) => this.actions.showError(`Не удалось открыть ${name}`, error)),
      },
      {
        label: 'Открыть в браузере',
        click: () => void this.actions.openEnvironmentInBrowser(environment)
          .catch((error) => this.actions.showError('Не удалось открыть в браузере', error)),
      },
      {
        label: 'Скопировать адрес',
        click: () => this.actions.copyText(this.actions.getEnvironmentUrl(environment)),
      },
    ];
  }

  buildTrayEnvironmentSection() {
    const cloudState = this.getCloudState();
    if (!cloudState.account?.apiKey) {
      return [
        {
          label: cloudState.account?.email ? `Войти заново: ${cloudState.account.email}` : 'Войти',
          click: () => void this.actions.connectCloudAccount()
            .catch((error) => this.actions.showError('Could not connect CloudCLI account', error)),
        },
      ];
    }

    if (!cloudState.environments.length) {
      return [{ label: 'Серверов пока нет', enabled: false }];
    }

    return cloudState.environments.map((environment) => ({
      label: `${environment.name || environment.subdomain} - ${environment.status}`,
      submenu: this.buildEnvironmentActionsSubmenu(environment),
    }));
  }

  buildAppMenu() {
    if (!this.mainWindow) return;
    const cloudState = this.getCloudState();
    const localState = this.getLocalState();
    const remoteItems = this.getRemoteEnvironmentMenuItems();
    const cloudAccountLabel = cloudState.account?.apiKey
      ? (cloudState.account?.email ? `Аккаунт: ${cloudState.account.email}` : 'Аккаунт')
      : (cloudState.account?.email ? `Войти заново: ${cloudState.account.email}` : 'Войти в аккаунт…');

    const template = [
      {
        label: this.appName,
        submenu: [
          { label: `О программе ${this.appName}`, role: 'about' },
          { type: 'separator' },
          {
            label: 'Главная',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('Could not show launcher', error)),
          },
          {
            label: 'Где работать…',
            accelerator: 'CmdOrCtrl+Shift+E',
            click: () => void this.actions.showEnvironmentPicker().catch((error) => this.actions.showError('Could not switch environment', error)),
          },
          {
            label: 'Сведения для поддержки',
            submenu: [
              {
                label: 'Скопировать сведения',
                click: () => void this.actions.copyDiagnostics(),
              },
            ],
          },
          { type: 'separator' },
          {
            label: process.platform === 'darwin' ? `Скрыть ${this.appName}` : 'Скрыть',
            role: 'hide',
            visible: process.platform === 'darwin',
          },
          { label: 'Скрыть остальные', role: 'hideOthers', visible: process.platform === 'darwin' },
          { label: 'Показать все', role: 'unhide', visible: process.platform === 'darwin' },
          { type: 'separator', visible: process.platform === 'darwin' },
          { label: `Выйти из ${this.appName}`, accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        ],
      },
      {
        label: 'Работа',
        submenu: [
          {
            label: 'Главная',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('Could not show launcher', error)),
          },
          {
            label: 'Где работать…',
            accelerator: 'CmdOrCtrl+Shift+E',
            click: () => void this.actions.showEnvironmentPicker().catch((error) => this.actions.showError('Could not switch environment', error)),
          },
          { type: 'separator' },
          {
            label: 'Этот компьютер',
            accelerator: 'CmdOrCtrl+L',
            click: () => void this.actions.openLocalInDesktop().catch((error) => this.actions.showError('Не удалось открыть этот компьютер', error)),
          },
          {
            label: 'Открыть в браузере',
            accelerator: 'CmdOrCtrl+Shift+W',
            click: () => void this.actions.openLocalWebUi().catch((error) => this.actions.showError('Could not open local web UI', error)),
          },
          {
            label: 'Скопировать адрес',
            accelerator: 'CmdOrCtrl+Shift+U',
            click: () => void this.actions.copyLocalWebUrl().catch((error) => this.actions.showError('Could not copy local web URL', error)),
          },
          { type: 'separator' },
          {
            label: 'Не выключать после закрытия',
            type: 'checkbox',
            checked: localState.desktopSettings.keepLocalServerRunning,
            click: (menuItem) => void this.actions.updateDesktopSetting('keepLocalServerRunning', menuItem.checked)
              .catch((error) => this.actions.showError('Could not update desktop setting', error)),
          },
          {
            label: 'Доступ из домашней сети',
            type: 'checkbox',
            checked: localState.desktopSettings.exposeLocalServerOnNetwork,
            click: (menuItem) => void this.actions.updateDesktopSetting('exposeLocalServerOnNetwork', menuItem.checked)
              .catch((error) => this.actions.showError('Could not update desktop setting', error)),
          },
        ],
      },
      {
        label: 'Аккаунт',
        submenu: [
          {
            label: cloudAccountLabel,
            accelerator: 'CmdOrCtrl+Shift+C',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('Не удалось открыть вход', error)),
          },
          {
            label: 'Обновить список серверов',
            click: () => void this.actions.refreshCloudEnvironments().catch((error) => this.actions.showError('Не удалось загрузить список серверов', error)),
            enabled: Boolean(cloudState.account?.apiKey),
          },
          {
            label: 'Выйти из аккаунта',
            click: () => void this.actions.clearCloudAccount().catch((error) => this.actions.showError('Could not logout', error)),
            enabled: Boolean(cloudState.account?.apiKey),
          },
          { type: 'separator' },
          {
            label: 'Мои серверы',
            submenu: remoteItems,
          },
        ],
      },
      {
        label: 'Правка',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'Вид',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          {
            label: 'Инструменты разработчика',
            click: () => this.openActiveTabDevTools(),
          },
          {
            label: 'Скопировать сведения о вкладках',
            click: () => this.copyWebContentsDiagnostics(),
          },
          {
            label: 'Перезагрузить вкладку',
            click: () => this.reloadActiveBrowserViewForDiagnostics(),
          },
          {
            label: 'Отсоединить вкладку',
            click: () => this.detachActiveBrowserViewForDiagnostics(),
          },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Окно',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : []),
        ],
      },
      {
        label: 'Помощь',
        submenu: [
        {
          label: 'Сайт программы',
          click: () => void this.actions.openCloudDashboard(),
        },
          {
            label: 'Скопировать сведения',
            click: () => void this.actions.copyDiagnostics(),
          },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.buildTrayMenu();
  }

  buildTrayMenu() {
    if (!this.tray) return;
    const cloudState = this.getCloudState();
    const localState = this.getLocalState();

    const template = [
      {
        label: 'Этот компьютер',
        submenu: [
          {
            label: 'Открыть этот компьютер',
            click: () => void this.actions.openLocalInDesktop().catch((error) => this.actions.showError('Не удалось открыть этот компьютер', error)),
          },
          {
            label: 'Открыть в браузере',
            click: () => void this.actions.openLocalWebUi().catch((error) => this.actions.showError('Could not open local web UI', error)),
          },
          {
            label: 'Скопировать адрес',
            click: () => void this.actions.copyLocalWebUrl().catch((error) => this.actions.showError('Could not copy local web URL', error)),
          },
        ],
      },
      {
        label: 'Мои серверы',
        submenu: this.buildTrayEnvironmentSection(),
      },
      { type: 'separator' },
      {
        label: cloudState.account?.email ? `Аккаунт: ${cloudState.account.email}` : 'Войти',
        click: () => void this.showLauncher().catch((error) => this.actions.showError('Не удалось открыть вход', error)),
      },
      {
        label: 'Выйти из аккаунта',
        click: () => void this.actions.clearCloudAccount().catch((error) => this.actions.showError('Could not logout', error)),
        enabled: Boolean(cloudState.account?.apiKey),
      },
      { type: 'separator' },
      {
        label: `Выйти из ${this.appName}`,
        role: 'quit',
      },
    ];

    this.tray.setToolTip(`${this.appName}${this.actions.getActiveTarget()?.name ? ` - ${this.actions.getActiveTarget().name}` : ''}`);
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  async showDesktopSettings() {
    if (!this.mainWindow) return this.getDesktopState();
    await this.ensureSettingsWindow('desktop-settings');
    return this.getDesktopState();
  }

  async showLocalSettings() {
    if (!this.mainWindow) return this.getDesktopState();
    await this.ensureSettingsWindow('local-settings');
    return this.getDesktopState();
  }

  async showActiveEnvironmentActionsMenu() {
    if (!this.mainWindow) return this.getDesktopState();
    const activeTarget = this.actions.getActiveTarget();
    if (activeTarget?.kind !== 'remote') return this.getDesktopState();

    const environment = this.getCloudState().environments.find((item) => item.id === activeTarget.id);
    if (!environment) return this.getDesktopState();

    const menu = Menu.buildFromTemplate(this.buildEnvironmentActionsSubmenu(environment));
    menu.popup({ window: this.mainWindow });
    return this.getDesktopState();
  }

  async showEnvironmentActionsMenu(environmentId) {
    if (!this.mainWindow) return this.getDesktopState();
    const environment = this.getCloudState().environments.find((item) => item.id === environmentId);
    if (!environment) return this.getDesktopState();

    const menu = Menu.buildFromTemplate(this.buildEnvironmentActionsSubmenu(environment));
    menu.popup({ window: this.mainWindow });
    return this.getDesktopState();
  }

  configurePermissions() {
    const isAllowedPermission = (webContents, permission) => {
      const sourceUrl = webContents.getURL();
      const allowedPermissions = new Set(['clipboard-read', 'media', 'notifications']);
      return isAllowedPermissionOrigin(sourceUrl, this.getCloudState().controlPlaneUrl) && allowedPermissions.has(permission);
    };

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isAllowedPermission(webContents, permission));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      if (!webContents) return false;
      return isAllowedPermission(webContents, permission);
    });
  }

  createTray() {
    if (this.tray) return;
    this.tray = new Tray(this.getTrayImage());
    this.tray.on('click', () => {
      if (!this.mainWindow) return;
      if (this.mainWindow.isVisible()) {
        this.mainWindow.focus();
      } else {
        this.mainWindow.show();
      }
    });
    this.buildTrayMenu();
  }

  async createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      // Окно сжимается до ширины телефона: интерфейс сам прячет левую панель
      // (выезжает по кнопке), как на iPhone. Было 1024 — сузить было нельзя.
      minWidth: 420,
      minHeight: 520,
      show: false,
      backgroundColor: '#0f172a',
      title: this.appName,
      icon: this.getWindowIconPath(),
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 18, y: 14 } }
        : {
            titleBarOverlay: {
              color: nativeTheme.shouldUseDarkColors ? '#111111' : '#f7f8fa',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a1a1' : '#5b6470',
              height: 44,
            },
          }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow?.show();
    });

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalUrl(url).catch((error) => this.actions.showError('Не удалось открыть ссылку', error));
      return { action: 'deny' };
    });

    const fitContent = () => {
      this.viewHost.resizeActiveView();
      this.syncSettingsWindowBounds();
    };
    this.mainWindow.on('resize', fitContent);
    // На части систем «развернуть» и полный экран не шлют resize с итоговым размером.
    for (const eventName of ['resized', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
      this.mainWindow.on(eventName, () => setTimeout(fitContent, 0));
    }

    this.mainWindow.on('move', () => {
      this.syncSettingsWindowBounds();
    });

    this.mainWindow.on('closed', () => {
      this.viewHost.clear();
      this.settingsWindow = null;
      this.mainWindow = null;
      this.launcherLoaded = false;
    });

    this.buildAppMenu();
    await this.showLauncher();
  }
}
