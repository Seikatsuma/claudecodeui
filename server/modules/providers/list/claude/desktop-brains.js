// «Мозги» настольной версии: правила работы, протокол к каждому сообщению,
// помощники и навыки, защита от разрушительных команд.
//
// Включается только в настольной программе: она передаёт серверу путь к папке
// мозгов в CLAUDE_UI_BRAINS_DIR (вложенная копия или свежая, скачанная с
// сервера аккаунтов). На сайте переменной нет — поведение прежнее.
//
// Почему не файлы в ~/.claude пользователя: это его личная папка со своими
// правилами и входом в Claude. Мозги подключаются поверх — добавкой к
// системным правилам, плагином и перехватчиками внутри этого процесса, — и
// ничего у человека не переписывают. Перехватчики здесь, а не скриптами:
// на Windows нет bash и python, а процесс сервера есть везде.
import fs from 'node:fs';
import path from 'node:path';

const PROTOCOL_SKIP = /^(?:да|нет|ок|окей|ага|угу|хорошо|спасибо|понял|ясно|дальше|продолжай|стоп|делай|давай)[\s.!,)]*$/i;
const SERVICE_MARKERS = ['<task-notification', '<system', '<command-', '<local-command', '[Request interrupted'];

// Разрушительные команды: удаление, затирание истории, форматирование.
// Пользователь сказал «да» — Claude повторяет команду с USER_CONFIRMED=da.
const DESTRUCTIVE = [
  [/\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, 'rm -r (рекурсивное удаление)'],
  [/\brm\s+-[a-zA-Z]*f/, 'rm -f (удаление без вопросов)'],
  [/\brmdir\s+\/s\b|\bdel\s+\/[sfq]/i, 'удаление папок в Windows'],
  [/\bRemove-Item\b[^|;]*-Recurse/i, 'Remove-Item -Recurse'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard (затирает несохранённую работу)'],
  [/\bgit\s+clean\s+-[a-zA-Z]*[fdx]/, 'git clean (удаляет файлы, которых нет в истории)'],
  [/\bgit\s+push\s+[^|;]*(?:--force|-f\b)/, 'git push --force (переписывает чужую историю)'],
  [/\bgit\s+(?:branch|checkout)\s+-D\b/, 'удаление ветки git'],
  [/\bgit\s+stash\s+(?:drop|clear)\b/, 'удаление отложенных правок git'],
  [/\b(?:drop|truncate)\s+(?:table|database|schema)\b/i, 'удаление таблиц или базы'],
  [/\bmkfs(?:\.\w+)?\b|\bdiskutil\s+erase|\bformat\s+[a-z]:/i, 'форматирование диска'],
  [/\bdd\s+[^|;]*\bof=\/dev\//, 'запись поверх диска'],
  [/\bshred\b|\bsrm\b/, 'безвозвратное затирание файлов'],
  [/\bfind\b[^|;]*\s-delete\b/, 'find -delete'],
];

let cached = { dir: null, stamp: null, value: null };

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function getBrainsDir() {
  const dir = process.env.CLAUDE_UI_BRAINS_DIR;
  if (!dir) return null;
  try {
    return fs.statSync(path.join(dir, 'CLAUDE.md')).isFile() ? dir : null;
  } catch {
    return null;
  }
}

function loadBrains(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  let stamp = '';
  try {
    stamp = String(fs.statSync(manifestPath).mtimeMs);
  } catch {
    stamp = String(fs.statSync(path.join(dir, 'CLAUDE.md')).mtimeMs);
  }
  if (cached.dir === dir && cached.stamp === stamp) return cached.value;

  // В правилах пути к методичкам записаны как {{BRAINS_DIR}}/docs/… — подставляем
  // настоящий путь этой установки (на Windows — с обратными косыми).
  const fill = (text) => text.split('{{BRAINS_DIR}}').join(dir);
  let version = null;
  try {
    version = JSON.parse(readText(manifestPath)).version || null;
  } catch {
    version = null;
  }
  const pluginDir = path.join(dir, 'plugin');
  const value = {
    dir,
    version,
    rules: fill(readText(path.join(dir, 'CLAUDE.md'))).trim(),
    protocol: fill(readText(path.join(dir, 'protocol.md'))).trim(),
    pluginDir: fs.existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json')) ? pluginDir : null,
  };
  cached = { dir, stamp, value };
  return value;
}

export function findDestructive(command) {
  const text = String(command || '');
  if (/(^|[\s;&|])USER_CONFIRMED=da\b/.test(text)) return null;
  for (const [pattern, label] of DESTRUCTIVE) {
    if (pattern.test(text)) return label;
  }
  return null;
}

function shouldAddProtocol(prompt) {
  const text = String(prompt || '').trim();
  if (!text || text.startsWith('/')) return false;
  const head = text.slice(0, 500);
  if (SERVICE_MARKERS.some((marker) => head.includes(marker))) return false;
  return !PROTOCOL_SKIP.test(text.toLowerCase().replace(/ё/g, 'е'));
}

/**
 * Накладывает мозги на параметры запуска Claude. Ничего не делает, если
 * программа не передала папку мозгов (сайт, чужие копии).
 */
export function applyDesktopBrains(sdkOptions) {
  const dir = getBrainsDir();
  if (!dir) return null;
  const brains = loadBrains(dir);

  if (brains.rules) {
    const current = sdkOptions.systemPrompt && typeof sdkOptions.systemPrompt === 'object'
      ? sdkOptions.systemPrompt
      : { type: 'preset', preset: 'claude_code' };
    sdkOptions.systemPrompt = {
      ...current,
      append: [current.append, brains.rules].filter(Boolean).join('\n\n'),
    };
  }

  if (brains.pluginDir) {
    const plugins = Array.isArray(sdkOptions.plugins) ? sdkOptions.plugins : [];
    if (!plugins.some((plugin) => plugin?.path === brains.pluginDir)) {
      sdkOptions.plugins = [...plugins, { type: 'local', path: brains.pluginDir }];
    }
  }

  const hooks = sdkOptions.hooks || {};
  if (brains.protocol) {
    hooks.UserPromptSubmit = [
      ...(hooks.UserPromptSubmit || []),
      {
        hooks: [async (input) => {
          if (!shouldAddProtocol(input?.prompt)) return {};
          return {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: brains.protocol,
            },
          };
        }],
      },
    ];
  }
  hooks.PreToolUse = [
    ...(hooks.PreToolUse || []),
    {
      matcher: 'Bash|PowerShell',
      hooks: [async (input) => {
        const label = findDestructive(input?.tool_input?.command);
        if (!label) return {};
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `СТОП: ${label}. Это личный компьютер пользователя — ничего не удалять и не затирать без его явного «да» текстом. `
              + 'Спроси пользователя одной строкой, что именно удаляешь и зачем. '
              + 'Если он УЖЕ ответил «да» в этом чате — повтори ту же команду с префиксом USER_CONFIRMED=da.',
          },
        };
      }],
    },
  ];
  sdkOptions.hooks = hooks;
  return brains;
}
