import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeConfigDirForEnv } from '@/shared/utils.js';

// Программа на компьютере: обычную ~/.claude Claude не называем — иначе на Mac
// он ищет вход не в той записи Связки ключей и отвечает «Not logged in».

const withEnv = (vars: Record<string, string | undefined>, run: () => void): void => {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const defaultDir = path.join(os.homedir(), '.claude');

test('программа: обычная ~/.claude — переменную не задаём', () => {
  withEnv({ CLAUDE_UI_DESKTOP: '1', CLAUDE_CONFIG_DIR: undefined }, () => {
    assert.equal(claudeConfigDirForEnv(defaultDir), null);
    assert.equal(claudeConfigDirForEnv(`${defaultDir}/`), null);
  });
});

test('программа: своя папка или папка из окружения — задаём как есть', () => {
  withEnv({ CLAUDE_UI_DESKTOP: '1', CLAUDE_CONFIG_DIR: undefined }, () => {
    assert.equal(claudeConfigDirForEnv('/tmp/other-claude'), '/tmp/other-claude');
  });
  withEnv({ CLAUDE_UI_DESKTOP: '1', CLAUDE_CONFIG_DIR: defaultDir }, () => {
    assert.equal(claudeConfigDirForEnv(defaultDir), defaultDir);
  });
});

test('сайт: поведение прежнее — папку задаём всегда', () => {
  withEnv({ CLAUDE_UI_DESKTOP: undefined, CLAUDE_CONFIG_DIR: undefined }, () => {
    assert.equal(claudeConfigDirForEnv(defaultDir), defaultDir);
    assert.equal(claudeConfigDirForEnv(null), null);
  });
});
