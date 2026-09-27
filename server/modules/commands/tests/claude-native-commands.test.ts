import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeNativeCommandsService } from '../claude-native-commands.service.js';

test('native commands get a leading slash, lose hidden and internal names, and come sorted', async () => {
  const service = createClaudeNativeCommandsService(async () => [
    { name: 'usage', description: 'Show usage', argumentHint: '' },
    { name: 'context', description: 'Context usage' },
    { name: 'fast', description: 'Fast mode' },
    { name: 'agents', description: 'Agents wizard' },
    { name: '__remote-workflow', description: 'internal' },
    { name: 'workflow-launch-exec', description: 'internal' },
    { name: 'context', description: 'duplicate' },
    { name: 'loop', description: 'Run on interval', argumentHint: '[interval] [prompt]' },
  ]);

  const commands = await service.listCommands();
  assert.deepEqual(commands.map((command) => command.name), ['/context', '/loop', '/usage']);
  assert.equal(commands.find((command) => command.name === '/loop')?.argumentHint, '[interval] [prompt]');
});

test('the probe runs once for concurrent callers and is cached until it expires', async () => {
  let clock = 0;
  let probes = 0;
  const service = createClaudeNativeCommandsService(async () => {
    probes += 1;
    return [{ name: 'context', description: '' }];
  }, () => clock);

  await Promise.all([service.listCommands(), service.listCommands()]);
  assert.equal(probes, 1);

  clock += 29 * 60 * 1000;
  await service.listCommands();
  assert.equal(probes, 1);

  clock += 2 * 60 * 1000;
  await service.listCommands();
  assert.equal(probes, 2);
});

test('a failed probe returns the last good list and retries after a minute', async () => {
  let clock = 0;
  let fail = false;
  let probes = 0;
  const service = createClaudeNativeCommandsService(async () => {
    probes += 1;
    if (fail) throw new Error('cli missing');
    return [{ name: 'usage', description: '' }];
  }, () => clock);

  assert.equal((await service.listCommands()).length, 1);

  fail = true;
  clock += 31 * 60 * 1000;
  assert.deepEqual((await service.listCommands()).map((command) => command.name), ['/usage']);
  assert.equal(probes, 2);

  clock += 30 * 1000;
  await service.listCommands();
  assert.equal(probes, 2);

  clock += 31 * 1000;
  await service.listCommands();
  assert.equal(probes, 3);
});

test('an empty probe result counts as a failure instead of wiping the menu', async () => {
  const service = createClaudeNativeCommandsService(async () => []);
  assert.deepEqual(await service.listCommands(), []);
});
