import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { devinRuntime } from './devin-runtime.provider.js';
import { DevinSessionsProvider, mapPermissionModeToDevinMode } from './devin-sessions.provider.js';

const sessionsProvider = new DevinSessionsProvider();
const runtimeContext = {
  resolveProviderSessionId: (sessionId) => sessionId === 'app-resume' ? 'devin-sess-1' : null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

/**
 * A fake `devin` binary that speaks just enough ACP: answers initialize /
 * session/new / session/load / session/set_* on stdin, streams a couple of
 * session/update notifications, then answers session/prompt. All requests are
 * captured to DEVIN_RPC_CAPTURE for assertions. Prompts hang forever when
 * DEVIN_HANG=1 (used to test abort).
 */
async function createFakeDevinExecutable(binDir) {
  const scriptPath = path.join(binDir, 'devin.js');
  await writeFile(scriptPath, `
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const cap = process.env.DEVIN_RPC_CAPTURE;
const seen = [];
const record = (m) => { seen.push(m); if (cap) fs.writeFileSync(cap, JSON.stringify({ args: process.argv.slice(2), calls: seen }, null, 2)); };
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');
const request = (id, method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');

let pendingPrompt = null; // msg.id of session/prompt waiting on permission
const finishPrompt = () => {
  if (!pendingPrompt) return;
  const { id, sid } = pendingPrompt;
  pendingPrompt = null;
  notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AFTER-PERMISSION' } } });
  respond(id, { stopReason: 'end_turn' });
  setTimeout(() => process.exit(0), 50);
};

rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method === undefined) {
    // Answer to OUR request (session/request_permission).
    record({ answer: msg });
    if (pendingPrompt) finishPrompt();
    return;
  }
  if (msg.method === undefined || msg.id === undefined) {
    record(msg); return; // notifications (session/cancel)
  }
  record(msg);
  switch (msg.method) {
    case 'initialize':
      respond(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      break;
    case 'session/new':
      respond(msg.id, { sessionId: 'devin-sess-1' });
      break;
    case 'session/load':
      // Replayed history MUST be muted by the runtime.
      notify('session/update', { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-OLD-TEXT' } } });
      respond(msg.id, { sessionId: msg.params.sessionId });
      break;
    case 'session/set_mode':
    case 'session/set_config_option':
      respond(msg.id, {});
      break;
    case 'session/prompt': {
      if (process.env.DEVIN_HANG === '1') return; // never answer → abort test
      const sid = msg.params.sessionId;
      if (process.env.DEVIN_PERMISSION_TEST === '1') {
        // Ask permission and hold the prompt until the client answers.
        pendingPrompt = { id: msg.id, sid };
        request(900, 'session/request_permission', {
          sessionId: sid,
          // Живой урезанный формат Devin (замерено 03.10.26): без title/rawInput.
          toolCall: { toolCallId: 'tc-perm', _meta: { 'cognition.ai/editableCommand': 'rm -rf /tmp/x' } },
          options: [
            { optionId: 'o-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'o-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'o-reject', name: 'Reject', kind: 'reject_once' },
          ],
        });
        return;
      }
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking hard' } } });
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LIVE-REPLY' } } });
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 100, size: 200000 } });
      respond(msg.id, { stopReason: 'end_turn', usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 } });
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

async function withFakeDevin(fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'devin-cli-test-'));
  const previousCliPath = process.env.DEVIN_CLI_PATH;
  const previousCapture = process.env.DEVIN_RPC_CAPTURE;
  const previousHang = process.env.DEVIN_HANG;
  const previousPermTest = process.env.DEVIN_PERMISSION_TEST;
  const previousRunsDir = process.env.CLOUDCLI_DEVIN_RUNS_DIR;
  const previousLiveRuns = process.env.CLOUDCLI_LIVE_RUNS_DIR;
  const shim = await createFakeDevinExecutable(tempRoot);
  process.env.DEVIN_CLI_PATH = shim;
  process.env.DEVIN_RPC_CAPTURE = path.join(tempRoot, 'rpc.json');
  // Супервизор и live-runs пишут в свои каталоги — в тестах они во временных.
  process.env.CLOUDCLI_DEVIN_RUNS_DIR = path.join(tempRoot, 'devin-runs');
  process.env.CLOUDCLI_LIVE_RUNS_DIR = path.join(tempRoot, 'live-runs');
  try {
    await fn(tempRoot);
  } finally {
    if (previousCliPath === undefined) delete process.env.DEVIN_CLI_PATH; else process.env.DEVIN_CLI_PATH = previousCliPath;
    if (previousCapture === undefined) delete process.env.DEVIN_RPC_CAPTURE; else process.env.DEVIN_RPC_CAPTURE = previousCapture;
    if (previousHang === undefined) delete process.env.DEVIN_HANG; else process.env.DEVIN_HANG = previousHang;
    if (previousPermTest === undefined) delete process.env.DEVIN_PERMISSION_TEST; else process.env.DEVIN_PERMISSION_TEST = previousPermTest;
    if (previousRunsDir === undefined) delete process.env.CLOUDCLI_DEVIN_RUNS_DIR; else process.env.CLOUDCLI_DEVIN_RUNS_DIR = previousRunsDir;
    if (previousLiveRuns === undefined) delete process.env.CLOUDCLI_LIVE_RUNS_DIR; else process.env.CLOUDCLI_LIVE_RUNS_DIR = previousLiveRuns;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/** Дождаться условия (опрос каждые 25 мс) или бросить по таймауту. */
async function waitFor(check, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

test('devin runtime: new session — handshake, session_created, streamed deltas, complete', async () => {
  await withFakeDevin(async (tempRoot) => {
    const writer = makeWriter();
    await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-new-1' }, writer, runtimeContext);

    const kinds = writer.messages.map((m) => m.kind);
    assert.equal(writer.sessionId, 'devin-sess-1', 'setSessionId got the provider id');
    assert.ok(kinds.indexOf('session_created') < kinds.indexOf('stream_delta'), 'session_created before deltas');
    assert.ok(writer.messages.some((m) => m.kind === 'thinking_delta' && m.content === 'thinking hard'));
    assert.ok(writer.messages.some((m) => m.kind === 'stream_delta' && m.content === 'LIVE-REPLY'));
    assert.ok(writer.messages.some((m) => m.kind === 'status' && m.tokenBudget));
    const completes = writer.messages.filter((m) => m.kind === 'complete');
    assert.equal(completes.length, 1, 'exactly one complete');
    assert.equal(completes[0].exitCode, 0);
    assert.ok(!writer.messages.some((m) => m.content === 'REPLAYED-OLD-TEXT'), 'no replayed text');

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const methods = capture.calls.map((c) => c.method);
    assert.deepEqual(methods.slice(0, 2), ['initialize', 'session/new']);
    assert.deepEqual(capture.args, ['acp']);
  });
});

test('devin runtime: resume — session/load replays are muted, no session_created', async () => {
  await withFakeDevin(async (tempRoot) => {
    const writer = makeWriter();
    await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-resume' }, writer, runtimeContext);

    const methods = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'))
      .calls.map((c) => c.method);
    assert.ok(methods.includes('session/load'));
    assert.ok(!methods.includes('session/new'));
    assert.ok(!writer.messages.some((m) => m.kind === 'session_created'), 'no session_created on resume');
    assert.ok(!writer.messages.some((m) => m.content === 'REPLAYED-OLD-TEXT'), 'load replay muted');
    assert.ok(writer.messages.some((m) => m.content === 'LIVE-REPLY'));
    assert.equal(writer.messages.filter((m) => m.kind === 'complete').length, 1);
  });
});

test('devin runtime: model + permission mode are passed to the agent', async () => {
  await withFakeDevin(async (tempRoot) => {
    const writer = makeWriter();
    await devinRuntime.run('Hi', {
      cwd: tempRoot,
      sessionId: 'app-model-1',
      model: 'swe-2-max',
      permissionMode: 'bypassPermissions',
    }, writer, runtimeContext);

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    // bypassPermissions → CLI flag `devin --permission-mode dangerous acp`
    // covers the spawn→set_mode window (the acp subcommand has no such flag).
    assert.deepEqual(capture.args, ['--permission-mode', 'dangerous', 'acp', '--model', 'swe-2-max']);
    const setMode = capture.calls.find((c) => c.method === 'session/set_mode');
    assert.equal(setMode?.params?.modeId, 'bypass');
    const setModel = capture.calls.find((c) => c.method === 'session/set_config_option');
    assert.equal(setModel?.params?.value, 'swe-2-max');
  });
});

test('devin runtime: a model other than SWE-2 is replaced by swe-2-high', async () => {
  for (const forbidden of ['claude-opus-5-5-medium', 'adaptive', 'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium', 'gpt-6-sol-high']) {
    await withFakeDevin(async (tempRoot) => {
      const writer = makeWriter();
      await devinRuntime.run('Hi', {
        cwd: tempRoot,
        sessionId: `app-forbidden-${forbidden}`,
        model: forbidden,
        permissionMode: 'default',
      }, writer, runtimeContext);

      const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
      assert.deepEqual(capture.args, ['acp', '--model', 'swe-2-high'], `model ${forbidden} must not reach the agent`);
      const setModel = capture.calls.find((c) => c.method === 'session/set_config_option');
      assert.equal(setModel?.params?.value, 'swe-2-high');
    });
  }
});

test('devin runtime: abort kills the ACP process and ends the run once', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_HANG = '1';
    const writer = makeWriter();
    const runPromise = devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-abort-1' }, writer, runtimeContext);

    // Wait until session/new has been answered (prompt is in flight, hung).
    for (let i = 0; i < 100; i += 1) {
      if (writer.sessionId === 'devin-sess-1') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(writer.sessionId, 'devin-sess-1');

    assert.equal(devinRuntime.abort('app-abort-1'), true);
    await runPromise;

    const completes = writer.messages.filter((m) => m.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].aborted, true);

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    assert.ok(capture.calls.some((c) => c.method === 'session/cancel'), 'session/cancel sent');

    // Second abort on a finished run is a no-op, not a phantom kill.
    assert.equal(devinRuntime.abort('app-abort-1'), false);
  });
});

test('mapPermissionModeToDevinMode maps UI modes onto ACP modes', () => {
  assert.equal(mapPermissionModeToDevinMode('bypassPermissions'), 'bypass');
  assert.equal(mapPermissionModeToDevinMode('acceptEdits'), 'accept-edits');
  assert.equal(mapPermissionModeToDevinMode('plan'), 'plan');
  assert.equal(mapPermissionModeToDevinMode('auto'), 'smart');
  assert.equal(mapPermissionModeToDevinMode('default'), undefined);
  assert.equal(mapPermissionModeToDevinMode(undefined), undefined);
});

test('devin sessions normalizeMessage: ACP updates → NormalizedMessage', () => {
  const chunk = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    's1',
  );
  assert.equal(chunk[0].kind, 'stream_delta');
  assert.equal(chunk[0].content, 'hello');
  assert.equal(chunk[0].provider, 'devin');

  const thought = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
    's1',
  );
  assert.equal(thought[0].kind, 'thinking_delta');

  const tool = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Run command', kind: 'execute', rawInput: { command: 'ls' } },
    's1',
  );
  assert.equal(tool[0].kind, 'tool_use');
  assert.equal(tool[0].toolId, 'tc1');

  const toolDone = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] },
    's1',
  );
  // tool_call_update text lives in content[].content.text in Devin's shape
  assert.equal(toolDone[0].kind, 'tool_result');
  assert.equal(toolDone[0].toolId, 'tc1');

  const echo = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'user echo' } },
    's1',
  );
  assert.equal(echo.length, 0);

  const noise = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    's1',
  );
  assert.equal(noise.length, 0);
});

test('devin runtime: permission request reaches the gateway, allow → allow_once', async () => {
  await withFakeDevin(async () => {
    process.env.DEVIN_PERMISSION_TEST = '1';
    const writer = makeWriter();
    const runPromise = devinRuntime.run('Hi', { cwd: '/tmp', sessionId: 'app-perm-1' }, writer, runtimeContext);

    const request = await waitFor(
      () => writer.messages.find((m) => m.kind === 'permission_request'),
      5000,
      'permission_request event',
    );
    assert.equal(request.provider, 'devin');
    assert.equal(request.sessionId, 'app-perm-1');
    assert.ok(request.requestId.startsWith('devin-perm-'));

    const pending = devinRuntime.permissions.listPending('app-perm-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].requestId, request.requestId);
    assert.equal(pending[0].toolName, 'rm');
    assert.equal(pending[0].input.command, 'rm -rf /tmp/x');
    assert.equal(pending[0].sessionId, 'app-perm-1');
    assert.ok(Array.isArray(pending[0].context.options));

    // «Allow once» → allow_once (не always).
    devinRuntime.permissions.resolve(request.requestId, { allow: true });
    await runPromise;

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const answer = capture.calls.find((c) => c.answer?.id === 900);
    assert.ok(answer, 'agent got the permission response');
    assert.equal(answer.answer.result.outcome.outcome, 'selected');
    assert.equal(answer.answer.result.outcome.optionId, 'o-once');

    // Ход после ответа дошёл до конца.
    assert.equal(devinRuntime.permissions.listPending('app-perm-1').length, 0);
    assert.ok(writer.messages.some((m) => m.content === 'AFTER-PERMISSION'));
    assert.equal(writer.messages.filter((m) => m.kind === 'complete').length, 1);
  });
});

test('devin runtime: deny → reject_once; remember → allow_always', async () => {
  await withFakeDevin(async () => {
    process.env.DEVIN_PERMISSION_TEST = '1';
    const writer = makeWriter();
    const runPromise = devinRuntime.run('Hi', { cwd: '/tmp', sessionId: 'app-perm-2' }, writer, runtimeContext);
    const request = await waitFor(
      () => writer.messages.find((m) => m.kind === 'permission_request'),
      5000,
      'permission_request event',
    );

    devinRuntime.permissions.resolve(request.requestId, { allow: false, message: 'no' });
    await runPromise;
    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    assert.equal(capture.calls.find((c) => c.answer?.id === 900)?.answer.result.outcome.optionId, 'o-reject');
  });

  await withFakeDevin(async () => {
    process.env.DEVIN_PERMISSION_TEST = '1';
    const writer = makeWriter();
    const runPromise = devinRuntime.run('Hi', { cwd: '/tmp', sessionId: 'app-perm-3' }, writer, runtimeContext);
    const request = await waitFor(
      () => writer.messages.find((m) => m.kind === 'permission_request'),
      5000,
      'permission_request event',
    );

    devinRuntime.permissions.resolve(request.requestId, { allow: true, rememberEntry: 'Shell' });
    await runPromise;
    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    assert.equal(capture.calls.find((c) => c.answer?.id === 900)?.answer.result.outcome.optionId, 'o-always');
  });
});

test('devin runtime: bypass auto-allows without touching the gateway', async () => {
  await withFakeDevin(async () => {
    process.env.DEVIN_PERMISSION_TEST = '1';
    const writer = makeWriter();
    await devinRuntime.run('Hi', {
      cwd: '/tmp',
      sessionId: 'app-perm-4',
      permissionMode: 'bypassPermissions',
    }, writer, runtimeContext);

    assert.ok(!writer.messages.some((m) => m.kind === 'permission_request'), 'no UI request under bypass');
    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const answer = capture.calls.find((c) => c.answer?.id === 900);
    assert.equal(answer?.answer.result.outcome.optionId, 'o-once', 'first allow_* picked');
  });
});

test('devin supervisor: ход переживает разрыв клиента, запрос разрешения доезжает до нового', async () => {
  await withFakeDevin(async () => {
    // session/prompt висит, пока не ответят на session/request_permission.
    process.env.DEVIN_PERMISSION_TEST = '1';

    const { spawnSupervisedDevin, connectSupervisedDevin } = await import('./devin-acp-client.js');
    const child = await spawnSupervisedDevin({
      command: process.env.DEVIN_CLI_PATH,
      args: ['acp'],
      cwd: '/tmp',
      env: process.env,
    });
    assert.ok(child.pid > 0, 'devin pid via supervisor');
    assert.ok(child.socketPath.endsWith('.sock'));

    const agentLines = [];
    child.stdout.on('data', (chunk) => agentLines.push(String(chunk)));

    const captureCalls = async () => {
      try {
        return JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8')).calls;
      } catch {
        return [];
      }
    };

    // «Сервер»: рукопожатие + prompt → агент спрашивает разрешение и ждёт.
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'devin-sess-1', prompt: [] } }) + '\n');
    await waitFor(async () => (await captureCalls()).some((c) => c.method === 'session/prompt'), 5000, 'prompt reached agent');
    await waitFor(() => agentLines.join('').includes('session/request_permission'), 5000, 'permission request forwarded');

    // «Смерть сервера»: сокет порвался — агент при этом должен жить,
    // потому что prompt ещё не отвечён.
    child.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    try { process.kill(child.pid, 0); } catch { assert.fail('devin died on client disconnect'); }

    // «Новый сервер»: переподключение — hello + повтор неотвеченного запроса.
    const lines = [];
    let turnEnded = false;
    const link = await connectSupervisedDevin({
      socketPath: child.socketPath,
      onLine: (line) => lines.push(line),
      onTurnEnd: () => { turnEnded = true; },
    });
    assert.equal(link.devinPid, child.pid);
    assert.equal(link.promptInFlight, true, 'prompt still in flight');
    await waitFor(() => lines.some((l) => l.includes('session/request_permission')), 5000, 'pending request replayed');

    // Отвечаем разрешением — агент завершает prompt.
    link.writeLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 900,
      result: { outcome: { outcome: 'selected', optionId: 'o-once' } },
    }));
    await waitFor(() => turnEnded, 5000, 'turn_end after answer');
    const calls = await captureCalls();
    const answer = calls.find((c) => c.answer?.id === 900);
    assert.equal(answer?.answer.result.outcome.optionId, 'o-once');

    link.close();
    // Ответный prompt закрыт, клиент отключён — супервизор добирает агента.
    await waitFor(() => {
      try { process.kill(child.pid, 0); return false; } catch { return true; }
    }, 5000, 'agent reaped after disconnect without prompt');
  });
});
