import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  adoptSurvivors,
  getSurvivorPhase,
  getSurvivorProvider,
  isSurvivorRunning,
  markShuttingDown,
  noteSurvivorProviderSession,
  pollSurvivors,
  readTranscriptPhase,
  readCodexEventPhase,
  resetSurvivorsForTests,
  spawnSurvivableClaude,
  stopSurvivor,
} from '@/modules/providers/list/claude/survivor-runs.js';

// «Агент»-заглушка: в строке запуска те же слова, что у настоящего claude, —
// по ним модуль отличает агента от чужой программы с тем же PID.
function fakeAgent(lifetimeMs: number) {
  return {
    command: process.execPath,
    args: ['-e', `setTimeout(() => {}, ${lifetimeMs})`, 'claude', '--output-format', 'stream-json'],
    env: process.env,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await check();
}

async function withLiveDir(runTest: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-runs-'));
  const previous = process.env.CLOUDCLI_LIVE_RUNS_DIR;
  process.env.CLOUDCLI_LIVE_RUNS_DIR = dir;
  resetSurvivorsForTests();
  try {
    await runTest(dir);
  } finally {
    resetSurvivorsForTests();
    if (previous === undefined) delete process.env.CLOUDCLI_LIVE_RUNS_DIR;
    else process.env.CLOUDCLI_LIVE_RUNS_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('при остановке сервера уборка SDK не убивает агента, новый сервер его находит и может остановить', async () => {
  await withLiveDir(async (dir) => {
    const child = spawnSurvivableClaude(fakeAgent(60000), { appSessionId: 'chat-1' });
    const files = await readdir(dir);
    assert.equal(files.length, 1, 'запись о запуске появилась');
    const pid = Number(files[0].replace('.json', ''));

    markShuttingDown();
    assert.equal(child.kill('SIGTERM'), false, 'во время остановки «убить» ничего не делает');
    assert.equal(alive(pid), true);

    const adopted = adoptSurvivors({ pollMs: 0 });
    assert.deepEqual(adopted.map((run) => run.sessionId), ['chat-1']);
    assert.equal(isSurvivorRunning('chat-1'), true);

    assert.equal(stopSurvivor('chat-1'), true);
    assert.equal(await waitFor(() => !alive(pid)), true, '«Стоп» останавливает пережившего агента');
    assert.equal(isSurvivorRunning('chat-1'), false);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('обычное завершение агента убирает запись, мёртвые записи не усыновляются', async () => {
  await withLiveDir(async (dir) => {
    const child = spawnSurvivableClaude(fakeAgent(200), { appSessionId: 'chat-2' });
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(await waitFor(async () => (await readdir(dir)).length === 0), true);
    assert.deepEqual(adoptSurvivors({ pollMs: 0 }), []);
  });
});

test('когда переживший агент закончил, сервер узнаёт об этом', async () => {
  await withLiveDir(async () => {
    const child = spawnSurvivableClaude(fakeAgent(700), { appSessionId: 'chat-3', configDir: '/nonexistent' });
    noteSurvivorProviderSession('chat-3', 'provider-3');
    markShuttingDown();
    adoptSurvivors({ pollMs: 0 });
    assert.equal(isSurvivorRunning('chat-3'), true);

    await new Promise((resolve) => child.once('exit', resolve));
    const gone: string[] = [];
    pollSurvivors({ onGone: (id: string) => gone.push(id) });
    assert.deepEqual(gone, ['chat-3']);
    assert.equal(isSurvivorRunning('chat-3'), false);
  });
});

test('Codex worker живёт после выхода запустившего процесса и усыновляется новым сайтом', async () => {
  await withLiveDir(async (dir) => {
    const eventPath = path.join(dir, 'codex-events.jsonl');
    const providerSessionId = 'codex-provider-1';
    await writeFile(eventPath,
      line({ type: 'thread.started', thread_id: providerSessionId })
      + line({ type: 'item.started', item: { type: 'reasoning', text: 'thinking' } }));

    const codexHome = path.join(dir, 'codex-home');
    const transcript = path.join(codexHome, 'sessions', '2026', '10', `rollout-${providerSessionId}.jsonl`);
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, '{}\n');

    // The launcher exits immediately. Only its detached grandchild remains,
    // exactly like a Codex worker after the website process is replaced.
    const launcher = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'codex-worker.provider.js', '--cloudcli-codex-worker'], { detached: true, stdio: 'ignore' });
      child.unref();
      process.stdout.write(String(child.pid));
    `;
    const pid = Number(execFileSync(process.execPath, ['-e', launcher], { encoding: 'utf8' }));
    assert.equal(alive(pid), true, 'осиротевший worker жив');

    await writeFile(path.join(dir, `${pid}.json`), JSON.stringify({
      pid,
      provider: 'codex',
      appSessionId: 'codex-chat-1',
      providerSessionId: null,
      configDir: codexHome,
      eventPath,
      startedAt: Date.now(),
    }));

    const mappings: unknown[] = [];
    const adopted = adoptSurvivors({
      pollMs: 0,
      onProviderSession: (appSessionId: string, nativeId: string, provider: 'claude' | 'codex', jsonlPath: string | null) => {
        mappings.push({ appSessionId, nativeId, provider, jsonlPath });
      },
    });
    assert.deepEqual(adopted.map((run) => run.provider), ['codex']);
    assert.equal(getSurvivorProvider('codex-chat-1'), 'codex');
    assert.deepEqual(getSurvivorPhase('codex-chat-1'), { phase: 'thinking', detail: null });
    assert.deepEqual(mappings, [{
      appSessionId: 'codex-chat-1',
      nativeId: providerSessionId,
      provider: 'codex',
      jsonlPath: transcript,
    }]);

    assert.equal(stopSurvivor('codex-chat-1'), true);
    assert.equal(await waitFor(() => !alive(pid)), true);
  });
});

test('этап Codex читается из журнала worker', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-phase-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    await writeFile(file, line({ type: 'turn.started' }));
    assert.deepEqual(readCodexEventPhase(file), { phase: 'thinking', detail: null });
    await appendFile(file, line({ type: 'item.started', item: { type: 'command_execution', command: 'pwd' } }));
    assert.deepEqual(readCodexEventPhase(file), { phase: 'tool', detail: 'Bash' });
    await appendFile(file, line({ type: 'item.completed', item: { type: 'agent_message', text: 'готово' } }));
    assert.deepEqual(readCodexEventPhase(file), { phase: 'writing', detail: null });
    await appendFile(file, line({ type: 'turn.completed', usage: {} }));
    assert.equal(readCodexEventPhase(file), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('завершившийся во время простоя сайта Codex восстанавливает mapping до уборки мёртвой записи', async () => {
  await withLiveDir(async (dir) => {
    const eventPath = path.join(dir, 'finished-codex.jsonl');
    await writeFile(eventPath,
      line({ type: 'thread.started', thread_id: 'finished-native-id' })
      + line({ type: 'turn.completed', usage: {} })
      + line({ type: 'worker.completed', exitCode: 0 }));
    const deadPid = 999_999_999;
    await writeFile(path.join(dir, `${deadPid}.json`), JSON.stringify({
      pid: deadPid,
      provider: 'codex',
      appSessionId: 'finished-app-id',
      providerSessionId: null,
      eventPath,
      startedAt: Date.now(),
    }));

    const mappings: string[] = [];
    const adopted = adoptSurvivors({
      pollMs: 0,
      onProviderSession: (appSessionId: string, nativeId: string) => mappings.push(`${appSessionId}:${nativeId}`),
    });
    assert.deepEqual(adopted, []);
    assert.deepEqual(mappings, ['finished-app-id:finished-native-id']);
    assert.deepEqual(await readdir(dir), ['finished-codex.jsonl']);
  });
});

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const toolUse = (id: string, name: string) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const toolResult = (id: string) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('этап пережившего агента читается по хвосту переписки', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'phase-'));
  try {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, line({ type: 'user', message: { content: 'сделай' } }));
    assert.deepEqual(readTranscriptPhase(file), { phase: 'requesting', detail: null });

    // Случай 15.09.26: помощник и команда запущены вместе, результатов нет.
    await appendFile(file, toolUse('a1', 'Agent') + toolUse('b1', 'Bash'));
    assert.deepEqual(readTranscriptPhase(file), { phase: 'agents', detail: '1' });

    await appendFile(file, toolResult('a1'));
    assert.deepEqual(readTranscriptPhase(file), { phase: 'tool', detail: 'Bash' });

    await appendFile(file, toolResult('b1'));
    assert.deepEqual(readTranscriptPhase(file), { phase: 'reading', detail: null });

    await appendFile(file, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'готово' }] } }));
    assert.deepEqual(readTranscriptPhase(file), { phase: 'writing', detail: null });

    assert.equal(readTranscriptPhase(path.join(dir, 'нет.jsonl')), null);

    // Служебная запись (подсказка хука и т.п.) этап не меняет.
    await appendFile(file, line({ type: 'user', isMeta: true, message: { content: 'служебное' } }));
    assert.deepEqual(readTranscriptPhase(file), { phase: 'writing', detail: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('прерванный вызов без результата не висит «Работает» вечно', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'phase-'));
  try {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, toolUse('b1', 'Bash')
      + line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));
    assert.equal(readTranscriptPhase(file), null, 'после прерывания этап неизвестен, не «Работает: Bash»');

    await appendFile(file, line({ type: 'user', message: { content: 'продолжай' } }));
    assert.deepEqual(readTranscriptPhase(file), { phase: 'requesting', detail: null });

    // Посреди идущей команды: уведомление о фоновой задаче и сообщение в очередь.
    await appendFile(file, toolUse('w1', 'Write')
      + line({ type: 'user', message: { content: '<task-notification>\n<task-id>x</task-id>' } })
      + line({ type: 'user', message: { content: 'я тебя жду' } }));
    assert.deepEqual(readTranscriptPhase(file), { phase: 'tool', detail: 'Write' }, 'вставки не закрывают идущую команду');
    await appendFile(file, toolResult('w1'));

    await appendFile(file, toolUse('a1', 'Agent')
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ответ' }] } }));
    assert.deepEqual(readTranscriptPhase(file), { phase: 'writing', detail: null }, 'текст модели закрывает незакрытые вызовы');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('переживший агент: этап известен сразу после усыновления и рассылается при смене', async () => {
  await withLiveDir(async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), 'cfg-'));
    try {
      const transcript = path.join(configDir, 'projects', '-home-claude', 'provider-4.jsonl');
      await mkdir(path.dirname(transcript), { recursive: true });
      await writeFile(transcript, toolUse('a1', 'Agent'));

      spawnSurvivableClaude(fakeAgent(60000), { appSessionId: 'chat-4', configDir });
      noteSurvivorProviderSession('chat-4', 'provider-4');
      markShuttingDown();
      adoptSurvivors({ pollMs: 0 });
      assert.deepEqual(getSurvivorPhase('chat-4'), { phase: 'agents', detail: '1' });

      await new Promise((resolve) => setTimeout(resolve, 20));
      await appendFile(transcript, toolResult('a1'));
      const phases: unknown[] = [];
      pollSurvivors({ onPhase: (_id: string, phase: { phase: string; detail: string | null } | null) => { phases.push(phase); } });
      assert.deepEqual(phases, [{ phase: 'reading', detail: null }]);

      let repeats = 0;
      pollSurvivors({ onPhase: () => { repeats += 1; } });
      assert.equal(repeats, 0, 'без изменений переписки повторно не рассылается');

      stopSurvivor('chat-4');
      assert.equal(getSurvivorPhase('chat-4'), null);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
