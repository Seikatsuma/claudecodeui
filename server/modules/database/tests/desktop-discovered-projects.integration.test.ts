import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

// Программа на компьютере: в панели — папки, открытые человеком, и история Claude;
// проекты из чужих историй (Codex, Cursor…) сами не появляются, убранные не возвращаются.

async function withDesktopDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previous = { db: process.env.DATABASE_PATH, desktop: process.env.CLAUDE_UI_DESKTOP };
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'desktop-projects-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.CLAUDE_UI_DESKTOP = '1';
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    for (const [key, value] of [['DATABASE_PATH', previous.db], ['CLAUDE_UI_DESKTOP', previous.desktop]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const archived = (projectPath: string): number | undefined => projectsDb.getProjectPath(projectPath)?.isArchived;

test('программа: проект из истории Codex появляется убранным, из истории Claude — видным', async () => {
  await withDesktopDatabase(() => {
    sessionsDb.createSession('codex-1', 'codex', '/home/r/personal-app', 'Личное');
    sessionsDb.createSession('claude-1', 'claude', '/home/r/work', 'Работа');
    assert.equal(archived('/home/r/personal-app'), 1);
    assert.equal(archived('/home/r/work'), 0);
  });
});

test('программа: Codex нашёлся раньше Claude — папка всё равно видна (синхронизаторы параллельны)', async () => {
  await withDesktopDatabase(() => {
    sessionsDb.createSession('codex-r', 'codex', '/home/r/both', 'Codex');
    assert.equal(archived('/home/r/both'), 1);
    sessionsDb.createSession('claude-r', 'claude', '/home/r/both', 'Claude');
    assert.equal(archived('/home/r/both'), 0);
  });
});

test('программа: убранный проект не возвращается от новой переписки в файлах, а «+» и чат в программе возвращают', async () => {
  await withDesktopDatabase(() => {
    sessionsDb.createSession('claude-0', 'claude', '/home/r/work', 'Прежний чат');
    projectsDb.updateProjectIsArchived('/home/r/work', true); // человек убрал сам
    sessionsDb.createSession('claude-2', 'claude', '/home/r/work', 'Из терминала');
    sessionsDb.createSession('claude-0', 'claude', '/home/r/work', 'Прежний чат'); // пересверка того же чата
    assert.equal(archived('/home/r/work'), 1, 'переписка из файлов не возвращает убранный проект');

    projectsDb.createProjectPath('/home/r/work'); // кнопка «+»
    assert.equal(archived('/home/r/work'), 0);

    sessionsDb.createSession('codex-3', 'codex', '/home/r/codex-only', 'Codex');
    sessionsDb.createAppSession('app-1', 'codex', '/home/r/codex-only'); // чат Codex, начатый в программе
    assert.equal(archived('/home/r/codex-only'), 0);
  });
});

test('программа: разовая уборка убирает только проекты из чужих историй', async () => {
  await withDesktopDatabase(() => {
    // Как у тех, кто поставил программу до сборки 22: всё добавлено видным.
    for (const projectPath of ['/home/r/codex-a', '/home/r/codex-starred', '/home/r/mixed', '/home/r/opened-empty', '/home/r/app-chat']) {
      projectsDb.createProjectPath(projectPath);
    }
    sessionsDb.createSession('c-a', 'codex', '/home/r/codex-a', 'a');
    sessionsDb.createSession('c-s', 'codex', '/home/r/codex-starred', 's');
    projectsDb.updateProjectIsStarred('/home/r/codex-starred', true);
    sessionsDb.createSession('c-m', 'codex', '/home/r/mixed', 'm');
    sessionsDb.createSession('cl-m', 'claude', '/home/r/mixed', 'm');
    sessionsDb.createAppSession('app-2', 'cursor', '/home/r/app-chat');

    const hidden = projectsDb.hideProjectsOnlyFromOtherAgents();

    assert.equal(archived('/home/r/codex-a'), 1);
    assert.equal(archived('/home/r/mixed'), 0, 'есть чат Claude — остаётся');
    assert.equal(archived('/home/r/opened-empty'), 0, 'пустая папка, открытая «+», — остаётся');
    assert.equal(archived('/home/r/app-chat'), 0, 'чат, начатый в программе, — остаётся');
    assert.equal(archived('/home/r/codex-starred'), 0, 'со звёздочкой — остаётся');
    assert.equal(hidden, 1);
  });
});

test('программа: «Показывать чаты из Codex» в настройках — возвращает их и новые появляются видными', async () => {
  await withDesktopDatabase(async () => {
    const { appConfigDb } = await import('@/modules/database/repositories/app-config.js');
    sessionsDb.createSession('c-old', 'codex', '/home/r/codex-old', 'старый');
    assert.equal(archived('/home/r/codex-old'), 1);

    appConfigDb.set('desktop.show_other_agents', '1');
    assert.equal(projectsDb.showProjectsOnlyFromOtherAgents(), 1);
    assert.equal(archived('/home/r/codex-old'), 0);
    sessionsDb.createSession('c-new', 'codex', '/home/r/codex-new', 'новый');
    assert.equal(archived('/home/r/codex-new'), 0);

    appConfigDb.set('desktop.show_other_agents', '0');
    assert.equal(projectsDb.hideProjectsOnlyFromOtherAgents(), 2);
  });
});

test('программа: проект Codex, убранный человеком вручную, переключатель не возвращает; «+» — возвращает', async () => {
  await withDesktopDatabase(async () => {
    const { appConfigDb } = await import('@/modules/database/repositories/app-config.js');
    appConfigDb.set('desktop.show_other_agents', '1');
    sessionsDb.createSession('c-mine', 'codex', '/home/r/codex-keep-away', 'личное');
    assert.equal(archived('/home/r/codex-keep-away'), 0);
    projectsDb.updateProjectIsArchived('/home/r/codex-keep-away', true); // «Убрать проект»
    projectsDb.rememberUserHiddenProject('/home/r/codex-keep-away');

    appConfigDb.set('desktop.show_other_agents', '0');
    projectsDb.hideProjectsOnlyFromOtherAgents();
    appConfigDb.set('desktop.show_other_agents', '1');
    projectsDb.showProjectsOnlyFromOtherAgents();
    assert.equal(archived('/home/r/codex-keep-away'), 1, 'убранный вручную остаётся убранным');

    projectsDb.createProjectPath('/home/r/codex-keep-away'); // открыл «+»
    assert.equal(archived('/home/r/codex-keep-away'), 0);
    projectsDb.updateProjectIsArchived('/home/r/codex-keep-away', true);
    projectsDb.showProjectsOnlyFromOtherAgents();
    assert.equal(archived('/home/r/codex-keep-away'), 0, 'после «+» память о ручном убирании стёрта');
  });
});

test('программа: папки в «<главная папка>/Проекты» сами встают слева, убранные вручную — нет', async () => {
  await withDesktopDatabase(async () => {
    const { appConfigDb } = await import('@/modules/database/repositories/app-config.js');
    const { mkdir, mkdtemp } = await import('node:fs/promises');
    const { syncWorkFolderProjects } = await import('@/modules/desktop/desktop-settings.js');
    const root = await mkdtemp(path.join(tmpdir(), 'glavnaya-'));
    await mkdir(path.join(root, 'Проекты', 'Отчёт по продажам'), { recursive: true });
    await mkdir(path.join(root, 'Проекты', 'Старое'), { recursive: true });
    appConfigDb.set('desktop.work_folder', root);

    projectsDb.createProjectPath(path.join(root, 'Проекты', 'Старое'));
    projectsDb.updateProjectIsArchived(path.join(root, 'Проекты', 'Старое'), true); // человек убрал

    await syncWorkFolderProjects();
    assert.equal(archived(path.join(root, 'Проекты', 'Отчёт по продажам')), 0);
    assert.equal(archived(path.join(root, 'Проекты', 'Старое')), 1, 'убранный вручную не возвращается');
  });
});
