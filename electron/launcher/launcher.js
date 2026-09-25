window.__APP_VERSION__ = '1.34.0';
window.__MOCK_STATE__ = {
  account: { connected: true, email: 'you@cloudcli.ai' },
  activeTarget: { kind: 'launcher', name: 'Launcher', url: null },
  cloudLoading: false,
  desktopSettings: { keepLocalServerRunning: false, exposeLocalServerOnNetwork: false, themeMode: 'system' },
  localWebUrl: 'http://localhost:3001',
  shareableWebUrl: 'http://localhost:3001',
  localServerRunning: false,
  localStartupLogs: [],
  environments: [
    { id: 'env-api', name: 'api-gateway', subdomain: 'api-gateway', access_url: 'https://api-gateway.cloudcli.ai', status: 'running', region: 'fra1', agent: 'Claude Code' },
    { id: 'env-web', name: 'web-frontend', subdomain: 'web-frontend', access_url: 'https://web-frontend.cloudcli.ai', status: 'stopped', region: 'sfo1', agent: 'Codex' },
    { id: 'env-data', name: 'data-pipeline', subdomain: 'data-pipeline', access_url: 'https://data-pipeline.cloudcli.ai', status: 'stopped', region: 'fra1', agent: 'Cursor' },
    { id: 'env-ml', name: 'ml-trainer', subdomain: 'ml-trainer', access_url: 'https://ml-trainer.cloudcli.ai', status: 'paused', region: 'iad1', agent: 'OpenCode' },
  ],
};

(function cloudCliLauncher() {
  var MOCK = window.__MOCK_STATE__ || {};
  var VERSION = window.__APP_VERSION__ || '';
  var LOGO_URL = new URL('../../public/logo-32.png', window.location.href).toString();
  var SEARCH = new URLSearchParams(window.location.search || '');

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  var mockState = clone(MOCK);
  var mockBridge = {
    getState: function () { return Promise.resolve(clone(mockState)); },
    openLocal: function () {
      mockState.localServerRunning = true;
      mockState.activeTarget = { kind: 'local', name: 'Local CloudCLI', url: mockState.localWebUrl };
      return Promise.resolve(clone(mockState));
    },
    openLocalWebUi: function () {
      mockState.localServerRunning = true;
      return Promise.resolve(clone(mockState));
    },
    copyLocalWebUrl: function () { return Promise.resolve(clone(mockState)); },
    connectCloud: function () {
      mockState.account = { connected: true, email: 'you@cloudcli.ai' };
      return Promise.resolve(clone(mockState));
    },
    disconnectCloud: function () {
      mockState.account = { connected: false, email: null };
      mockState.environments = [];
      mockState.tabs = (mockState.tabs || []).filter(function (tab) { return tab.kind !== 'remote'; });
      mockState.activeTabId = 'home';
      mockState.activeTarget = { kind: 'launcher', name: 'Launcher', url: null };
      return Promise.resolve(clone(mockState));
    },
    refreshEnvironments: function () { return Promise.resolve(clone(mockState)); },
    refreshActiveTab: function () { return Promise.resolve(clone(mockState)); },
    copyDiagnostics: function () { return Promise.resolve(clone(mockState)); },
    showEnvironmentPicker: function () { return Promise.resolve(clone(mockState)); },
    showLauncher: function () { return Promise.resolve(clone(mockState)); },
    showLocalSettings: function () { return Promise.resolve(clone(mockState)); },
    showDesktopSettings: function () { return Promise.resolve(clone(mockState)); },
    closeSettingsWindow: function () { return Promise.resolve(clone(mockState)); },
    showActiveEnvironmentActionsMenu: function () { return Promise.resolve(clone(mockState)); },
    openCloudDashboard: function () { return Promise.resolve(clone(mockState)); },
    runActiveEnvironmentAction: function () { return Promise.resolve(clone(mockState)); },
    switchTab: function (id) { mockState.activeTabId = id; return Promise.resolve(clone(mockState)); },
    closeTab: function (id) {
      mockState.tabs = (mockState.tabs || []).filter(function (tab) { return tab.id === 'home' || tab.id !== id; });
      if (mockState.activeTabId === id) mockState.activeTabId = 'home';
      return Promise.resolve(clone(mockState));
    },
    updateSetting: function (key, value) {
      mockState.desktopSettings = mockState.desktopSettings || {};
      mockState.desktopSettings[key] = key === 'themeMode' ? value : !!value;
      return Promise.resolve(clone(mockState));
    },
    openEnvironment: function (id) {
      var env = (mockState.environments || []).filter(function (item) { return item.id === id; })[0];
      if (env) {
        env.status = 'starting';
        setTimeout(function () {
          env.status = 'running';
          mockState.activeTarget = { kind: 'remote', id: id, name: env.name, url: env.access_url };
        }, 1700);
      }
      return Promise.resolve(clone(mockState));
    },
  };

  var bridge = window.cloudcliDesktop || mockBridge;

  var ICONS = {
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9 4 4 0 0 0 7 19z"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6l-.03.08a2 2 0 1 1-3.94 0L10 20a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1l-.08-.03a2 2 0 1 1 0-3.94L4 10a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6l.03-.08a2 2 0 1 1 3.94 0L14 4a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.36.4.7.6 1l.08.03a2 2 0 1 1 0 3.94L20 14a1.7 1.7 0 0 0-.6 1z"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>',
    arrow: '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    cloudPlus: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9 4 4 0 0 0 7 19z"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="9" y1="12" x2="15" y2="12"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  };
  var FILLED = { play: true };

  function icon(name, size) {
    size = size || 16;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="' + (FILLED[name] ? 'currentColor' : 'none') + '" stroke="' + (FILLED[name] ? 'none' : 'currentColor') + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function statusMeta(status) {
    var map = {
      running: { label: 'Работает', cls: 'ok', dot: '#10b981', verb: 'Открываю', open: 'Открыть' },
      starting: { label: 'Запускается', cls: 'warn', dot: '#f59e0b', verb: 'Запускаю', open: 'Открыть', busy: true },
      stopped: { label: 'Остановлен', cls: 'idle', dot: '#6b7280', verb: 'Запускаю', open: 'Запустить' },
      paused: { label: 'На паузе', cls: 'warn', dot: '#f59e0b', verb: 'Продолжаю', open: 'Продолжить' },
    };
    return map[status] || { label: status || '—', cls: 'idle', dot: '#6b7280', verb: 'Открываю', open: 'Открыть' };
  }

  function connected(state) {
    return !!(state && state.account && state.account.connected);
  }

  function authState(state) {
    return state && state.account ? (state.account.authState || (state.account.connected ? 'connected' : 'logged_out')) : 'logged_out';
  }

  function accountLabel(state) {
    if (authState(state) === 'expired') return 'Войти заново';
    if (state && state.account && state.account.email) return state.account.email;
    if (connected(state)) return 'Аккаунт';
    return 'Войти';
  }

  function localUrl(state) {
    return (state && (state.shareableWebUrl || state.localWebUrl)) || '';
  }

  function envCount(state) {
    var count = state && state.environments ? state.environments.length : 0;
    return count ? 'серверов: ' + count : 'серверов нет';
  }

  function errMsg(error) {
    return error && error.message ? error.message : String(error);
  }

  function resolveTheme(state) {
    var settings = state && state.desktopSettings ? state.desktopSettings : {};
    var mode = settings.themeMode || 'system';
    if (mode === 'light' || mode === 'dark') return mode;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  var CC = {
    icon: icon,
    esc: esc,
    statusMeta: statusMeta,
    connected: connected,
    authState: authState,
    accountLabel: accountLabel,
    localUrl: localUrl,
    envCount: envCount,
    version: VERSION,
    logoUrl: LOGO_URL,
    platform: 'win',
    state: clone(MOCK),
    ui: {},
    _busyEnv: null,
    _status: { msg: '', tone: '' },
    _reg: {},
    _wired: false,
    _poll: null,
    modalMode: SEARCH.get('modal') === '1',
  };

  window.CC = CC;

  var app;
  var overlay;

  CC.setState = function (state) {
    var currentSheet = CC.ui.openSheet || (CC.modalMode ? (CC.ui.initialSheet || 'desktop-settings') : null);
    var sheetBody = overlay ? overlay.querySelector('.cc-sheet-body') : null;
    var scrollTop = sheetBody ? sheetBody.scrollTop : 0;
    if (state && typeof state === 'object') CC.state = state;
    CC.applyTheme(CC.state);
    CC.render(CC.state);
    if (currentSheet) {
      CC.openSheet(currentSheet, { scrollTop: scrollTop });
    }
  };

  CC.applyTheme = function (state) {
    var settings = state && state.desktopSettings ? state.desktopSettings : {};
    var themeMode = settings.themeMode || 'system';
    var resolvedTheme = resolveTheme(state);
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.setAttribute('data-theme-mode', themeMode);
  };

  CC.refresh = function () {
    return Promise.resolve(bridge.getState()).then(function (state) {
      CC.setState(state);
      return state;
    });
  };

  CC.run = function (label, fn) {
    CC._status = { msg: label, tone: 'progress' };
    CC.render(CC.state);
    return Promise.resolve()
      .then(fn)
      .then(function (state) {
        if (state && state.environments) CC.state = state;
        return CC.refresh();
      })
      .then(function () {
        CC._status = { msg: '', tone: '' };
        CC.render(CC.state);
      })
      .catch(function (error) {
        CC._status = { msg: errMsg(error), tone: 'error' };
        CC.render(CC.state);
      });
  };

  CC.startPolling = function () {
    if (CC._poll) return;
    var ticks = 0;
    CC._poll = setInterval(function () {
      ticks += 1;
      Promise.resolve(bridge.getState()).then(function (state) {
        CC.setState(state);
        var anyStarting = (state.environments || []).some(function (environment) { return environment.status === 'starting'; });
        if (!anyStarting || ticks > 16) {
          clearInterval(CC._poll);
          CC._poll = null;
          if (!anyStarting) {
            CC._status = { msg: '', tone: '' };
            CC.render(CC.state);
          }
        }
      });
    }, 1500);
  };

  CC.openEnv = function (id) {
    var env = (CC.state.environments || []).filter(function (environment) { return environment.id === id; })[0];
    var meta = statusMeta(env ? env.status : '');
    CC._busyEnv = id;
    CC._status = { msg: (meta.verb || 'Открываю') + ' ' + ((env && (env.name || env.subdomain)) || 'сервер') + '…', tone: 'progress' };
    if (env) {
      var tabId = 'remote:' + env.id;
      var tabs = CC.state.tabs && CC.state.tabs.length ? CC.state.tabs : [{ id: 'home', title: 'Главная', kind: 'launcher', closable: false }];
      tabs = tabs.map(function (tab) {
        tab.active = false;
        return tab;
      });
      var existing = tabs.filter(function (tab) { return tab.id === tabId; })[0];
      if (existing) {
        existing.active = true;
        existing.title = env.name || env.subdomain;
      } else {
        tabs.push({ id: tabId, title: env.name || env.subdomain, kind: 'remote', closable: true, active: true });
      }
      CC.state.tabs = tabs;
      CC.state.activeTabId = tabId;
    }
    if (env && env.status !== 'running') env.status = 'starting';
    CC.render(CC.state);
    return Promise.resolve(bridge.openEnvironment(id)).then(function (state) {
      if (state && state.environments) CC.setState(state);
      CC.startPolling();
    }).catch(function (error) {
      CC._busyEnv = null;
      if (env) env.status = 'stopped';
      CC._status = { msg: errMsg(error), tone: 'error' };
      CC.render(CC.state);
    });
  };

  CC.act = function (name, node) {
    switch (name) {
      case 'local':
        return CC.run('Открываю этот компьютер…', function () { return bridge.openLocal(); });
      case 'connect':
        return CC.run('', function () { return bridge.showLauncher(); });
      case 'home':
        return CC.run('', function () { return bridge.showLauncher(); });
      case 'logout':
        return CC.run('Выхожу…', function () { return bridge.disconnectCloud(); });
      case 'open-web':
        return CC.run('Открываю в браузере…', function () { return bridge.openLocalWebUi(); });
      case 'copy-web':
        return CC.run('Адрес скопирован', function () { return bridge.copyLocalWebUrl(); });
      case 'diagnostics':
        return CC.run('Сведения скопированы', function () { return bridge.copyDiagnostics(); });
      case 'set-setting':
        return CC.run('Сохранено', function () { return bridge.updateSetting(node.key, node.value); });
      case 'set-theme-mode':
        return CC.run('Сохранено', function () { return bridge.updateSetting('themeMode', node.value); });
      case 'settings-toggle':
        return CC.run('Открываю настройки…', function () { return bridge.showDesktopSettings(); });
      case 'desktop-settings-toggle':
        return CC.run('Открываю настройки…', function () { return bridge.showDesktopSettings(); });
      case 'local-settings-toggle':
        return CC.run('Открываю настройки…', function () { return bridge.showLocalSettings(); });
      case 'settings-close':
        return CC.closeSheet();
      case 'dashboard':
        return CC.run('Открываю…', function () { return bridge.openCloudDashboard(); });
      case 'refresh-environments':
        return CC.run('Обновляю список серверов…', function () { return bridge.refreshEnvironments(); });
      case 'refresh-tab':
        return CC.run('Обновляю…', function () { return bridge.refreshActiveTab(); });
      case 'env-action':
        return CC.run('Открываю…', function () { return bridge.runActiveEnvironmentAction(node.getAttribute('data-cc-env-action')); });
      case 'env-menu':
        return CC.run('Открываю…', function () { return bridge.showActiveEnvironmentActionsMenu(); });
      case 'env-row-menu':
        return CC.run('Открываю…', function () { return bridge.showEnvironmentActionsMenu(node.getAttribute('data-cc-environment-id')); });
      default:
        return;
    }
  };

  function renderTabs(state) {
    var tabs = state.tabs && state.tabs.length ? state.tabs : [{ id: 'home', title: 'Главная', closable: false, active: true }];
    return tabs.map(function (tab) {
      var title = tab.title || '';
      var visibleChars = Math.min(title.length, 20);
      var tabWidth = Math.max(96, Math.min(232, (visibleChars * 8) + (tab.closable ? 56 : 38)));
      return '<button class="tb-tab no-drag' + (tab.active ? ' active' : '') + '" data-cc-tab="' + esc(tab.id) + '" title="' + esc(title) + '" style="width:' + tabWidth + 'px;flex-basis:' + tabWidth + 'px">' +
        '<span>' + esc(title) + '</span>' +
        (tab.closable ? '<span class="tb-close" data-cc-close-tab="' + esc(tab.id) + '" title="Закрыть вкладку">&times;</span>' : '') +
        '</button>';
    }).join('');
  }

  CC.titlebar = function (state) {
    var conn = connected(state);
    var activeTab = (state.tabs || []).filter(function (tab) { return tab.active; })[0] || null;
    var activeEnvironmentId = state.activeTarget && state.activeTarget.kind === 'remote' ? state.activeTarget.id : null;
    if (!activeEnvironmentId && activeTab && /^remote:/.test(activeTab.id || '')) {
      activeEnvironmentId = activeTab.id.replace(/^remote:/, '');
    }
    var activeRefreshable = (state.activeTarget && (state.activeTarget.kind === 'remote' || state.activeTarget.kind === 'local')) ||
      (activeTab && activeTab.id !== 'home');
    var envActions = '';
    var refreshAction = activeRefreshable ? '<button class="icon-btn tb-action tb-refresh no-drag" data-cc-action="refresh-tab" title="Обновить вкладку">' + icon('refresh', 16) + '</button>' : '';
    var logoutAction = (conn || authState(state) === 'expired') ? '<button class="icon-btn tb-action tb-logout no-drag" data-cc-action="logout" title="Выйти из аккаунта">' + icon('logOut', 16) + '</button>' : '';
    return '<div class="titlebar">' +
      '<div class="brand"><img class="mk" src="' + esc(LOGO_URL) + '" alt=""><span class="brand-name">Claude UI</span></div>' +
      '<div class="tb-tabs no-drag">' + renderTabs(state) + '</div>' +
      '<span style="flex:1"></span>' +
      refreshAction +
      envActions +
      '<button class="btn sm tb-action no-drag" data-cc-action="home" title="' + esc(authState(state) === 'expired' ? 'Войти заново' : accountLabel(state)) + '"><span class="dot" style="background:' + (conn ? 'var(--ok)' : (authState(state) === 'expired' ? 'var(--warn)' : 'var(--tx3)')) + '"></span><span class="tb-acct-label">' + esc(accountLabel(state)) + '</span></button>' +
      logoutAction +
      '<button class="icon-btn tb-action no-drag" data-cc-action="settings-toggle" title="Настройки программы">' + icon('settings', 16) + '</button>' +
      '</div>';
  };

  CC.statusbar = function (state) {
    var status = CC._status || {};
    var running = !!state.localServerRunning;
    return '<div class="statusbar">' +
      '<span><span class="dot" style="width:7px;height:7px;background:' + (running ? 'var(--ok)' : 'var(--tx3)') + '"></span> этот компьютер: ' + (running ? 'запущен' : 'не запущен') + '</span>' +
      '<span class="sep">·</span><span>' + esc(envCount(state)) + '</span>' +
      '<span class="sep">·</span><span>' + (authState(state) === 'expired' ? 'вход устарел' : (connected(state) ? esc(accountLabel(state)) : 'не выполнен вход')) + '</span>' +
      '<span style="flex:1"></span>' +
      (status.msg ? '<span class="status-msg ' + esc(status.tone) + '">' + esc(status.msg) + '</span><span class="sep">·</span>' : '') +
      '<span>v' + esc(state.appVersion || VERSION) + '</span>' +
      '</div>';
  };

  CC.renderSheet = function (title, subtitle, sections, footer) {
    overlay.innerHTML =
      '<div class="cc-sheet cc-modal">' +
      '<div class="cc-sheet-header">' +
      '<div class="cc-sheet-copy"><div class="cc-sheet-title">' + esc(title) + '</div><div class="cc-sheet-subtitle">' + esc(subtitle || '') + '</div></div>' +
      '<button class="icon-btn cc-sheet-close" data-cc-action="settings-close" title="Close">' + icon('x', 16) + '</button>' +
      '</div>' +
      '<div class="cc-sheet-body">' + sections.join('') + '</div>' +
      (footer ? '<div class="cc-sheet-footer">' + footer + '</div>' : '') +
      '</div>';
  };

  CC.renderSection = function (eyebrow, title, body) {
    return '<section class="cc-section">' +
      '<div class="cc-section-head">' +
      '<div class="lbl">' + esc(eyebrow) + '</div>' +
      '<div class="cc-section-title">' + esc(title) + '</div>' +
      '</div>' +
      '<div class="cc-section-body">' + body + '</div>' +
      '</section>';
  };

  CC.renderRadioOption = function (name, value, checked, title, description) {
    return '<label class="cc-choice">' +
      '<input type="radio" name="' + esc(name) + '" value="' + esc(value) + '"' + (checked ? ' checked' : '') + '>' +
      '<span><b>' + esc(title) + '</b><br>' + esc(description) + '</span>' +
      '</label>';
  };

  CC.openSheet = function (sheet, options) {
    options = options || {};
    if (sheet === 'desktop-settings') {
      CC.renderDesktopSettings();
    } else {
      CC.renderLocalSettings();
    }
    CC.ui.openSheet = sheet;
    overlay.classList.add('open');
    if (typeof options.scrollTop === 'number') {
      var body = overlay.querySelector('.cc-sheet-body');
      if (body) body.scrollTop = options.scrollTop;
    }
  };

  CC.closeSheet = function () {
    if (CC.modalMode && bridge.closeSettingsWindow) {
      CC.ui.openSheet = null;
      return bridge.closeSettingsWindow();
    }
    CC.ui.openSheet = null;
    overlay.classList.remove('open');
  };

  CC.buildLocalServerSection = function (state, options) {
    options = options || {};
    var settings = state.desktopSettings || {};
    var url = localUrl(state) || 'starts on demand';
    var body = '<div class="cc-surface">' +
      '<div class="cc-meta mono">' + esc(url) + '</div>' +
      '<div class="cc-row2"><button class="btn sm" data-cc-action="open-web">' + icon('arrow', 14) + 'Open in browser</button><button class="btn sm" data-cc-action="copy-web">' + icon('copy', 14) + 'Copy URL</button></div>';
    if (options.includePreferences) {
      body +=
        '<label class="cc-toggle"><input type="checkbox" data-cc-setting="keepLocalServerRunning"' + (settings.keepLocalServerRunning ? ' checked' : '') + '><span><b>Keep server running</b><br>Leave Local CloudCLI available after you quit the app.</span></label>' +
        '<label class="cc-toggle"><input type="checkbox" data-cc-setting="exposeLocalServerOnNetwork"' + (settings.exposeLocalServerOnNetwork ? ' checked' : '') + '><span><b>Allow LAN access</b><br>Use the copied URL from another device on this network.</span></label>';
    }
    body += '</div>';
    return CC.renderSection(
      options.eyebrow || 'LOCAL SERVER',
      options.title || 'Run Local CloudCLI on this machine',
      body
    );
  };

  CC.buildThemeSection = function (state) {
    var settings = state.desktopSettings || {};
    return CC.renderSection('APPEARANCE', 'Desktop theme', '' +
      '<div class="cc-surface cc-choice-group">' +
      CC.renderRadioOption('desktop-theme', 'system', settings.themeMode === 'system', 'System', 'Follow the operating system appearance.') +
      CC.renderRadioOption('desktop-theme', 'light', settings.themeMode === 'light', 'Light', 'Use the light interface appearance.') +
      CC.renderRadioOption('desktop-theme', 'dark', settings.themeMode === 'dark', 'Dark', 'Use the dark interface appearance.') +
      '</div>'
    );
  };

  CC.renderLocalSettings = function () {
    var state = CC.state || {};
    var sections = [
      CC.buildLocalServerSection(state, { includePreferences: false }),
      CC.renderSection('PREFERENCES', 'How the local service behaves', '' +
        '<div class="cc-surface">' +
        '<label class="cc-toggle"><input type="checkbox" data-cc-setting="keepLocalServerRunning"' + ((state.desktopSettings || {}).keepLocalServerRunning ? ' checked' : '') + '><span><b>Keep server running</b><br>Leave Local CloudCLI available after you quit the app.</span></label>' +
        '<label class="cc-toggle"><input type="checkbox" data-cc-setting="exposeLocalServerOnNetwork"' + ((state.desktopSettings || {}).exposeLocalServerOnNetwork ? ' checked' : '') + '><span><b>Allow LAN access</b><br>Use the copied URL from another device on this network.</span></label>' +
        '</div>'
      ),
    ];
    CC.renderSheet('Local Settings', 'Manage how Local CloudCLI runs on this computer.', sections);
  };

  CC.renderDesktopSettings = function () {
    var sections = [
      CC.buildThemeSection(CC.state || {}),
    ];
    CC.renderSheet('Desktop Settings', 'Manage the desktop app appearance.', sections);
  };

  CC.render = function (state) {
    state = state || CC.state;
    var titlebar = (CC._reg.titlebar || CC.titlebar)(state);
    var statusbar = (CC._reg.statusbar || CC.statusbar)(state);
    var body = CC._reg.renderBody ? CC._reg.renderBody(state) : '';
    if (CC.modalMode) {
      app.innerHTML = '';
    } else {
      app.innerHTML = titlebar + '<div class="cc-body ' + (CC._reg.bodyClass || '') + '">' + body + '</div>' + statusbar;
    }
    if (CC._reg.afterRender) CC._reg.afterRender(state);
  };

  function wireEvents() {
    if (CC._wired) return;
    CC._wired = true;

    document.addEventListener('click', function (event) {
      if (CC._reg.onClick && CC._reg.onClick(event)) return;
      var closeTab = event.target.closest('[data-cc-close-tab]');
      if (closeTab) {
        event.stopPropagation();
        CC.run('Закрываю вкладку…', function () { return bridge.closeTab(closeTab.getAttribute('data-cc-close-tab')); });
        return;
      }
      var tab = event.target.closest('[data-cc-tab]');
      if (tab) {
        CC.run('', function () { return bridge.switchTab(tab.getAttribute('data-cc-tab')); });
        return;
      }
      var action = event.target.closest('[data-cc-action]');
      if (action) {
        CC.act(action.getAttribute('data-cc-action'), action);
        return;
      }
      var env = event.target.closest('[data-cc-env]');
      if (env) {
        CC.openEnv(env.getAttribute('data-cc-env'));
        return;
      }
      if (overlay.classList.contains('open') && !event.target.closest('.cc-sheet')) {
        CC.closeSheet();
      }
    });

    document.addEventListener('change', function (event) {
      var setting = event.target.closest('[data-cc-setting]');
      if (setting) {
        CC.act('set-setting', {
          key: setting.getAttribute('data-cc-setting'),
          value: setting.checked,
        });
        return;
      }
      var theme = event.target.closest('[name="desktop-theme"]');
      if (theme) {
        CC.act('set-theme-mode', { value: theme.value });
        return;
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && overlay.classList.contains('open')) {
        CC.closeSheet();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        CC.act('settings-toggle');
        return;
      }
      if (overlay.classList.contains('open')) return;
      if (CC._reg.onKey) CC._reg.onKey(event, CC.state);
    });
  }

  function boot() {
    app = document.getElementById('app');
    overlay = document.createElement('div');
    overlay.id = 'cc-overlay';
    overlay.className = 'cc-overlay';
    document.body.appendChild(overlay);

    var isMac = /Mac/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent);
    var isWin = /Win/i.test(navigator.platform);
    CC.platform = isMac ? 'mac' : (isWin ? 'win' : 'linux');
    document.body.classList.add(CC.platform);
    CC.ui.initialSheet = SEARCH.get('sheet') || 'desktop-settings';
    if (CC.modalMode) {
      document.documentElement.classList.add('cc-modal-window');
      document.body.classList.add('cc-modal-window');
    }

    wireEvents();
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        CC.applyTheme(CC.state);
      });
    }
    if (bridge.onStateUpdated) {
      bridge.onStateUpdated(function (state) { CC.setState(state); });
    }
    if (bridge.onLauncherCommand) {
      bridge.onLauncherCommand(function (command) {
        if (command && command.type === 'open-sheet') {
          CC.ui.initialSheet = command.sheet || CC.ui.initialSheet || 'desktop-settings';
          CC.openSheet(command.sheet);
        }
      });
    }
    CC.refresh().catch(function (error) {
      CC._status = { msg: errMsg(error), tone: 'error' };
      CC.render(CC.state);
    });
  }

  CC.register = function (registry) {
    CC._reg = registry || {};
  };

  CC.start = function () {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  };
})();

(function homeApp() {
  var CC = window.CC;
  var bridge = window.cloudcliDesktop;
  // Черновик формы живёт между перерисовками (состояние программы приходит часто).
  var form = { mode: 'login', name: '', email: '', password: '', error: '', busy: false };

  function field(id, label, type, value, hint, autocomplete) {
    return '<label class="auth-f"><span class="auth-l">' + label + '</span>' +
      '<input class="auth-i" id="' + id + '" type="' + type + '" value="' + CC.esc(value) + '" autocomplete="' + autocomplete + '" spellcheck="false">' +
      (hint ? '<span class="auth-h">' + hint + '</span>' : '') + '</label>';
  }

  function authPane() {
    var isRegister = form.mode === 'register';
    return '<div class="auth">' +
      '<div class="auth-card">' +
      '<img class="auth-logo" src="' + CC.esc(CC.logoUrl) + '" alt="">' +
      '<h1 class="auth-t">' + (isRegister ? 'Регистрация' : 'Вход в Claude UI') + '</h1>' +
      '<p class="auth-s">Тот же интерфейс, что на сайте. Claude работает с папками этого компьютера.</p>' +
      '<form id="auth-form" novalidate>' +
      (isRegister ? field('auth-name', 'Как вас зовут', 'text', form.name, '', 'name') : '') +
      field('auth-email', 'Почта', 'email', form.email, '', 'email') +
      field('auth-password', 'Пароль', 'password', form.password, isRegister ? 'Не короче 8 знаков' : '', isRegister ? 'new-password' : 'current-password') +
      (form.error ? '<div class="auth-err" role="alert">' + CC.esc(form.error) + '</div>' : '') +
      '<button class="btn pri auth-go" type="submit"' + (form.busy ? ' disabled' : '') + '>' +
      (form.busy ? (isRegister ? 'Создаю аккаунт…' : 'Вхожу…') : (isRegister ? 'Создать аккаунт' : 'Войти')) + '</button>' +
      '</form>' +
      '<div class="auth-switch">' + (isRegister
        ? 'Уже есть аккаунт? <button class="link" data-auth-mode="login">Войти</button>'
        : 'Нет аккаунта? <button class="link" data-auth-mode="register">Зарегистрироваться</button>') + '</div>' +
      '</div></div>';
  }

  function serverRow(environment) {
    return '<button class="place" data-cc-env="' + CC.esc(environment.id) + '">' +
      '<span class="place-ic">' + CC.icon('cloud', 18) + '</span>' +
      '<span class="place-i"><span class="place-n">' + CC.esc(environment.name || environment.subdomain) + '</span>' +
      '<span class="place-u">' + CC.esc((environment.access_url || '').replace(/^https?:\/\//, '')) + '</span></span>' +
      '<span class="place-go">Открыть</span></button>';
  }

  function homePane(state) {
    var account = state.account || {};
    var who = account.name ? account.name + ' · ' + account.email : account.email;
    var servers = (state.environments || []);
    var computer = state.platform === 'darwin' ? 'Mac' : (state.platform === 'win32' ? 'компьютер с Windows' : 'компьютер');
    return '<div class="home">' +
      '<h2 class="pane-title">Где работать</h2>' +
      '<button class="place place-main" data-cc-action="local">' +
      '<span class="place-ic">' + CC.icon('monitor', 18) + '</span>' +
      '<span class="place-i"><span class="place-n">Этот компьютер</span>' +
      '<span class="place-u">Папки и файлы на этом ' + (state.platform === 'darwin' ? 'Mac' : 'компьютере') + (state.localServerRunning ? ' · запущено' : '') + '</span></span>' +
      '<span class="place-go">Открыть</span></button>' +
      (servers.length
        ? '<div class="lbl home-lbl">Мои серверы</div>' + servers.map(serverRow).join('')
        : '') +
      '<div class="lbl home-lbl">Аккаунт</div>' +
      '<div class="acct">' +
      '<div class="acct-i"><div class="acct-n">' + CC.esc(who || '') + '</div>' +
      '<div class="acct-m">' + CC.esc(account.planLabel || 'Личный') + (state.brainsVersion ? ' · мозги ' + CC.esc(state.brainsVersion) : '') + '</div></div>' +
      '<button class="btn sm" data-cc-action="logout">' + CC.icon('logOut', 14) + 'Выйти</button>' +
      '</div>' +
      '<p class="home-note">Claude в программе думает по вашей подписке Claude (Pro или Max). Первый раз войдите в неё: в интерфейсе «Настройки» → «Агенты» → Claude → «Войти», и подтвердите вход в браузере.</p>' +
      '<span hidden>' + CC.esc(computer) + '</span>' +
      '</div>';
  }

  function renderBody(state) {
    return '<div class="sb-main home-wrap">' + (CC.connected(state) ? homePane(state) : authPane()) + '</div>';
  }

  function readForm() {
    var name = document.getElementById('auth-name');
    var email = document.getElementById('auth-email');
    var password = document.getElementById('auth-password');
    if (name) form.name = name.value;
    if (email) form.email = email.value;
    if (password) form.password = password.value;
  }

  function submit() {
    readForm();
    var isRegister = form.mode === 'register';
    var email = form.email.trim();
    if (!email || email.indexOf('@') < 1) {
      form.error = 'Впишите почту.';
      return CC.render(CC.state);
    }
    if (!form.password) {
      form.error = 'Впишите пароль.';
      return CC.render(CC.state);
    }
    if (isRegister && form.password.length < 8) {
      form.error = 'Пароль — не короче 8 знаков.';
      return CC.render(CC.state);
    }
    form.error = '';
    form.busy = true;
    CC.render(CC.state);
    var fields = { email: email, password: form.password, name: form.name.trim() };
    var call = isRegister ? bridge.register(fields) : bridge.signIn(fields);
    Promise.resolve(call).then(function (state) {
      form.busy = false;
      form.password = '';
      if (state) CC.setState(state);
    }).catch(function (error) {
      form.busy = false;
      // Ошибка из главного процесса приходит с приставкой «Error invoking remote method…».
      form.error = String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
      CC.render(CC.state);
    });
  }

  function onClick(event) {
    var mode = event.target.closest('[data-auth-mode]');
    if (mode) {
      readForm();
      form.mode = mode.getAttribute('data-auth-mode');
      form.error = '';
      CC.render(CC.state);
      return true;
    }
    return false;
  }

  function afterRender() {
    var formNode = document.getElementById('auth-form');
    if (!formNode) return;
    formNode.addEventListener('submit', function (event) {
      event.preventDefault();
      submit();
    });
    formNode.addEventListener('input', function () { readForm(); });
    var focusId = form.mode === 'register' && !form.name ? 'auth-name' : (!form.email ? 'auth-email' : 'auth-password');
    var focusNode = document.getElementById(focusId);
    if (focusNode && document.activeElement === document.body) focusNode.focus();
  }

  CC.register({
    bodyClass: 'v-home',
    renderBody: renderBody,
    onClick: onClick,
    afterRender: afterRender,
  });
  CC.start();
})();
