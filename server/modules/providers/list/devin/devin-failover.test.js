import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Пути слотов считаются от HOME в момент импорта модулей — подменяем до него.
// XDG_* убираем: переменные среды запустившего тесты процесса протекли бы в
// окружение фейкового devin слота 1 и тот решил бы, что он — слот 2.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-failover-'));
const savedEnv = {
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
process.env.HOME = fakeHome;
delete process.env.XDG_DATA_HOME;
delete process.env.XDG_CONFIG_HOME;

const { devinRuntime } = await import('./devin-runtime.provider.js');
const { DevinSessionsProvider } = await import('./devin-sessions.provider.js');

const sessionsProvider = new DevinSessionsProvider();
const runtimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

/**
 * Фейковый `devin`: говорит ровно столько ACP, сколько нужно ходу. Слот
 * определяет по своему окружению (слот 2 = XDG_DATA_HOME с .devin-account2).
 * session/prompt на слоте из DEVIN_FAIL_SLOT ('1', '2', 'all') отвечает живой
 * ошибкой лимита из журнала 07.10.26. Вызовы пишет в DEVIN_RPC_CAPTURE.slot<N>.
 */
async function createFakeDevinExecutable(binDir) {
  const scriptPath = path.join(binDir, 'devin.js');
  await writeFile(scriptPath, `
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const cap = process.env.DEVIN_RPC_CAPTURE;
const slot = (process.env.XDG_DATA_HOME || '').includes('.devin-account2') ? '2' : '1';
const seen = [];
const record = (m) => { seen.push(m); if (cap) fs.writeFileSync(cap + '.slot' + slot, JSON.stringify({ slot, calls: seen }, null, 2)); };
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');

rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === undefined || msg.id === undefined) { record(msg); return; }
  record(msg);
  switch (msg.method) {
    case 'initialize':
      respond(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      break;
    case 'session/new':
      respond(msg.id, { sessionId: 'devin-sess-1' });
      break;
    case 'session/load':
      respond(msg.id, { sessionId: msg.params.sessionId });
      break;
    case 'session/set_mode':
    case 'session/set_config_option':
      respond(msg.id, {});
      break;
    case 'session/prompt': {
      const fail = process.env.DEVIN_FAIL_SLOT === 'all' || process.env.DEVIN_FAIL_SLOT === slot;
      if (fail && process.env.DEVIN_FAIL_MODE === 'stderr') {
        // Процесс умирает, не ответив на prompt: лимит виден только в stderr.
        process.stderr.write('Reached free model rate limit. Your limit will reset in 30 seconds.\\n');
        setTimeout(() => process.exit(0), 30);
        break;
      }
      if (fail) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: {
          code: -32010,
          message: 'Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 30 seconds.',
          data: { 'cognition.ai/errorKind': 'unavailable', 'cognition.ai/retryable': true },
        } }) + '\\n');
        setTimeout(() => process.exit(0), 50);
        break;
      }
      const sid = msg.params.sessionId;
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LIVE-REPLY-SLOT' + slot } } });
      respond(msg.id, { stopReason: 'end_turn' });
      setTimeout(() => process.exit(0), 50);
      break;
    }
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } }) + '\\n');
  }
});
`, 'utf8');

  const shim = path.join(binDir, 'devin');
  await writeFile(shim, '#!/bin/sh\nexec node "$(dirname "$0")/devin.js" "$@"\n', 'utf8');
  await chmod(shim, 0o755);
  return shim;
}

function makeWriter() {
  const messages = [];
  return {
    messages,
    sessionId: null,
    userId: null,
    send(message) { messages.push(message); },
    setSessionId(sessionId) { this.sessionId = sessionId; },
  };
}

/** Оба слота «вошли»: credentials.toml по НАСТОЯЩИМ путям — слот 1 без вложенного devin. */
function seedSlotCredentials() {
  for (const file of [
    path.join(fakeHome, '.local', 'share', 'devin', 'credentials.toml'),
    path.join(fakeHome, '.devin-account2', 'data', 'devin', 'credentials.toml'),
  ]) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'credentials.toml'), 'windsurf_api_key = "test"\n');
  }
}

async function withFakeDevin(fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'devin-failover-run-'));
  const saved = {
    DEVIN_CLI_PATH: process.env.DEVIN_CLI_PATH,
    DEVIN_RPC_CAPTURE: process.env.DEVIN_RPC_CAPTURE,
    DEVIN_FAIL_SLOT: process.env.DEVIN_FAIL_SLOT,
    DEVIN_FAIL_MODE: process.env.DEVIN_FAIL_MODE,
    CLOUDCLI_DEVIN_RUNS_DIR: process.env.CLOUDCLI_DEVIN_RUNS_DIR,
    CLOUDCLI_LIVE_RUNS_DIR: process.env.CLOUDCLI_LIVE_RUNS_DIR,
  };
  const shim = await createFakeDevinExecutable(tempRoot);
  process.env.DEVIN_CLI_PATH = shim;
  process.env.DEVIN_RPC_CAPTURE = path.join(tempRoot, 'rpc.json');
  process.env.CLOUDCLI_DEVIN_RUNS_DIR = path.join(tempRoot, 'devin-runs');
  process.env.CLOUDCLI_LIVE_RUNS_DIR = path.join(tempRoot, 'live-runs');
  try {
    await fn(tempRoot);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // Супервизор дописывает devin-runs с опозданием — rm без повторов
    // падает ENOTEMPTY (та же гонка, что у abort-теста соседнего файла).
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('devin failover: лимит слота 1 — ход повторяется на слоте 2, та же беседа, без ошибки в ленте', async () => {
  seedSlotCredentials();
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_FAIL_SLOT = '1';
    const writer = makeWriter();
    await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-failover-1' }, writer, runtimeContext);

    assert.ok(!writer.messages.some((m) => m.kind === 'error'), 'ошибки в ленту не ушли');
    assert.ok(writer.messages.some((m) => m.content === 'LIVE-REPLY-SLOT2'), 'ответ пришёл со слота 2');
    assert.ok(
      writer.messages.some((m) => m.kind === 'status' && /другой аккаунт/i.test(String(m.text))),
      'строка статуса про переключение показана',
    );
    const completes = writer.messages.filter((m) => m.kind === 'complete');
    assert.equal(completes.length, 1, 'ровно один complete за ход');
    assert.equal(completes[0].exitCode, 0);

    const slot1 = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE + '.slot1', 'utf8'));
    const slot2 = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE + '.slot2', 'utf8'));
    const methods1 = slot1.calls.map((c) => c.method);
    const methods2 = slot2.calls.map((c) => c.method);
    assert.ok(methods1.includes('session/new'), 'попытка 1 создала беседу');
    assert.ok(!methods2.includes('session/new'), 'повтор не создаёт новую беседу');
    const load = slot2.calls.find((c) => c.method === 'session/load');
    assert.equal(load?.params?.sessionId, 'devin-sess-1', 'повтор поднял ту же беседу');

    const activeSlot = fs.readFileSync(path.join(fakeHome, '.devin-account2', 'active-slot'), 'utf8').trim();
    assert.equal(activeSlot, '2', 'активный слот переключён насовсем');
  });
});

test('devin failover: лимит на обоих слотах — ошибка показывается один раз, без второго переключения', async () => {
  seedSlotCredentials();
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_FAIL_SLOT = 'all';
    const writer = makeWriter();
    // Слот 1 ограничен → повтор на слоте 2 → там тоже лимит → обычная ошибка
    // хода (run отклоняет — так же, как любой другой сбой Devin).
    await assert.rejects(
      devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-failover-2' }, writer, runtimeContext),
      /rate limit/i,
    );

    // Повтор на втором слоте был — prompt ушёл на ОБА слота (порядок слотов
    // не проверяем: активный слот мог остаться «2» от прошлого теста).
    const slot1 = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE + '.slot1', 'utf8'));
    const slot2 = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE + '.slot2', 'utf8'));
    assert.ok(slot1.calls.some((c) => c.method === 'session/prompt'), 'prompt ушёл на слот 1');
    assert.ok(slot2.calls.some((c) => c.method === 'session/prompt'), 'prompt ушёл и на слот 2 — повтор был');

    const errors = writer.messages.filter((m) => m.kind === 'error');
    assert.equal(errors.length, 1, 'одна ошибка в ленте');
    assert.match(String(errors[0].content), /rate limit/i);
    const completes = writer.messages.filter((m) => m.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].exitCode, 1);
  });
});

test('devin failover: процесс умер с лимитом в stderr (без ответа на prompt) — повтор на слоте 2, без ошибки', async () => {
  seedSlotCredentials();
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_FAIL_SLOT = '1';
    process.env.DEVIN_FAIL_MODE = 'stderr';
    const writer = makeWriter();
    // Процесс умирает молча: onClose видит лимит в хвосте stderr и сам
    // запускает повтор — отклонённый session/prompt НЕ должен добить ход
    // красной ошибкой поверх (разбор проверяющего 07.10.26).
    await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-failover-stderr' }, writer, runtimeContext);

    assert.ok(!writer.messages.some((m) => m.kind === 'error'), 'ошибки в ленту не ушли');
    assert.ok(writer.messages.some((m) => m.content === 'LIVE-REPLY-SLOT2'), 'ответ пришёл со слота 2');
    const completes = writer.messages.filter((m) => m.kind === 'complete');
    assert.equal(completes.length, 1, 'ровно один complete');
    assert.equal(completes[0].exitCode, 0);
  });
});
