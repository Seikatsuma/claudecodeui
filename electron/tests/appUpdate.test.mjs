// Проверки обновления программы без установщика: node --test electron/tests/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppUpdater } from '../appUpdate.js';

const DEPS = 'a'.repeat(64);

async function makeApp(root, build) {
  const appRoot = path.join(root, 'app');
  await fs.mkdir(path.join(appRoot, 'node_modules', 'some-pkg'), { recursive: true });
  await fs.writeFile(path.join(appRoot, 'node_modules', 'some-pkg', 'index.js'), 'export default 1;\n');
  await fs.writeFile(path.join(appRoot, 'update-build.json'), JSON.stringify({ build, depsHash: DEPS }));
  return appRoot;
}

async function makeBundle(root, build, { depsHash = DEPS, withServer = true } = {}) {
  const dir = path.join(root, `bundle-${build}`);
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.writeFile(path.join(dir, 'dist', 'index.html'), `<html>${build}</html>`);
  if (withServer) {
    await fs.mkdir(path.join(dir, 'dist-server', 'server'), { recursive: true });
    await fs.writeFile(path.join(dir, 'dist-server', 'server', 'index.js'), `// сборка ${build}\n`);
  }
  await fs.writeFile(path.join(dir, 'update-build.json'), JSON.stringify({ build, depsHash }));
  const archive = path.join(root, `claudeui-update-${build}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dir, '.']);
  const sha256 = crypto.createHash('sha256').update(readFileSync(archive)).digest('hex');
  return { archive, sha256, depsHash };
}

async function serve(routes) {
  const server = http.createServer(async (req, res) => {
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    const body = typeof route === 'function' ? await route() : route;
    res.writeHead(200);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function setup({ installed = 10, latest = 11, bundleOptions = {}, shaOverride } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appupdate-'));
  const appRoot = await makeApp(root, installed);
  const bundle = await makeBundle(root, latest, bundleOptions);
  const manifest = {
    build: latest, depsHash: bundle.depsHash, url: `claudeui-update-${latest}.tar.gz`,
    sha256: shaOverride || bundle.sha256, notes: 'проверка',
  };
  const server = await serve({
    '/api/app-update': JSON.stringify(manifest),
    [`/api/claudeui-update-${latest}.tar.gz`]: () => fs.readFile(bundle.archive),
  });
  const updater = new AppUpdater({
    appRoot, userDataDir: path.join(root, 'user'), updateUrl: `${server.url}/api/app-update`,
  });
  return { root, appRoot, updater, server };
}

test('новая сборка находится, ставится рядом и становится рабочей', async () => {
  const { updater, server, appRoot } = await setup();
  try {
    assert.equal(updater.getActiveRoot(), null);
    assert.equal((await updater.check()).status, 'available');
    // Двойное нажатие — одна установка.
    const [first, second] = await Promise.all([updater.install(), updater.install()]);
    assert.equal(first, 11);
    assert.equal(second, 11);
    const active = updater.getActiveRoot();
    assert.ok(active.endsWith(path.join('builds', '11')), 'каждая сборка — в своей папке');
    assert.ok(active);
    assert.equal(readFileSync(path.join(active, 'dist', 'index.html'), 'utf8'), '<html>11</html>');
    // Пакеты — ссылка на установку, а не копия.
    assert.equal(await fs.realpath(path.join(active, 'node_modules')), await fs.realpath(path.join(appRoot, 'node_modules')));
    assert.equal(updater.getRunningBuild(), 11);
    assert.equal((await updater.check()).status, 'idle');
  } finally {
    await server.close();
  }
});

test('испорченный файл не ставится и рабочую версию не трогает', async () => {
  const { updater, server } = await setup({ shaOverride: 'b'.repeat(64) });
  try {
    await updater.check();
    await assert.rejects(updater.install(), /отпечаток/);
    assert.equal(updater.getActiveRoot(), null);
    assert.equal(updater.getState().status, 'available');
  } finally {
    await server.close();
  }
});

test('новая сборка с другими пакетами — только установщиком', async () => {
  const { updater, server } = await setup({ bundleOptions: { depsHash: 'c'.repeat(64) } });
  try {
    assert.equal((await updater.check()).status, 'installer');
    await assert.rejects(updater.install(), /Новой версии нет/);
  } finally {
    await server.close();
  }
});

test('архив без сервера отвергается', async () => {
  const { updater, server } = await setup({ bundleOptions: { withServer: false } });
  try {
    await updater.check();
    await assert.rejects(updater.install(), /нет интерфейса или сервера/);
    assert.equal(updater.getActiveRoot(), null);
  } finally {
    await server.close();
  }
});

test('не запустившаяся сборка больше не берётся и не предлагается', async () => {
  const { updater, server } = await setup();
  try {
    await updater.check();
    await updater.install();
    assert.ok(updater.getActiveRoot());
    await updater.markActiveBad();
    assert.equal(updater.getActiveRoot(), null);
    assert.equal(updater.getRunningBuild(), 10);
    assert.equal((await updater.check()).status, 'idle');
  } finally {
    await server.close();
  }
});

test('переустановка программы новее скачанной начинки — работает установленная', async () => {
  const { updater, server, appRoot } = await setup();
  try {
    await updater.check();
    await updater.install();
    await fs.writeFile(path.join(appRoot, 'update-build.json'), JSON.stringify({ build: 12, depsHash: DEPS }));
    const fresh = new AppUpdater({ appRoot, userDataDir: path.dirname(updater.root), updateUrl: updater.updateUrl });
    assert.equal(fresh.getActiveRoot(), null);
    assert.equal(fresh.getRunningBuild(), 12);
  } finally {
    await server.close();
  }
});

test('сборка на своей машине (без номера) не проверяет обновления', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appupdate-'));
  const appRoot = await makeApp(root, 0);
  let called = false;
  const updater = new AppUpdater({
    appRoot, userDataDir: path.join(root, 'user'), updateUrl: 'http://127.0.0.1:9/x',
    fetchImpl: async () => { called = true; throw new Error('не должно вызываться'); },
  });
  assert.equal(updater.getState().enabled, false);
  await updater.check();
  assert.equal(called, false);
  assert.ok(!existsSync(path.join(root, 'user', 'app-update')));
});

test('уборка: остатки прерванной установки и старые сборки уходят, рабочая и прежняя остаются', async () => {
  const { updater, server } = await setup();
  try {
    await updater.check();
    await updater.install();
    await fs.mkdir(path.join(updater.buildsDir, '.next-123'), { recursive: true });
    await fs.mkdir(path.join(updater.buildsDir, '7'), { recursive: true });
    await fs.writeFile(path.join(updater.root, 'download-12.tar.gz'), 'x');
    await updater.cleanup();
    const left = (await fs.readdir(updater.buildsDir)).sort();
    assert.deepEqual(left, ['11']);
    assert.ok(!existsSync(path.join(updater.root, 'download-12.tar.gz')));
    assert.ok(updater.getActiveRoot());
  } finally {
    await server.close();
  }
});
