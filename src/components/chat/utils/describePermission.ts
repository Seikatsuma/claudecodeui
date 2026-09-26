/**
 * Запрос разрешения человеческим языком: что Claude хочет сделать и с чем.
 * Используется окном разрешения (PermissionRequestsBanner) — как в Claude
 * Desktop: вопрос, файл или команда, для правки — что уберётся и что добавится.
 */
export type PermissionKind = 'edit' | 'write' | 'command' | 'read' | 'web' | 'search' | 'other';

export type PermissionDescription = {
  kind: PermissionKind;
  title: string;
  /** Файл: имя крупно, папка мелко. */
  fileName?: string;
  fileDir?: string;
  /** Команда, адрес, запрос — моноширинным блоком. */
  code?: string;
  /** Пояснение Claude к команде (поле description у Bash). */
  note?: string;
  removed?: string;
  added?: string;
  /** Красная пометка: команда удаляет или затирает. */
  danger?: string;
  /** Подпись кнопки «Разрешать всегда …». */
  alwaysLabel: string;
};

const DANGER_PATTERNS: Array<[RegExp, string]> = [
  [/(^|[\s;&|(`$"'])(?:rm|rmdir|rd|del|erase|ri|unlink)(?:\s|$)|\bRemove-Item\b|shutil\.rmtree|os\.remove|\.rmSync\(|\bfind\b[^|;]*-delete/i,
    'Команда удаляет файлы — проверьте, что именно.'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*[fdx]|checkout\s+(?:--\s+)?\.|restore\s+\.|push\s+[^|;]*(?:--force|-f\b))/i,
    'Команда затирает изменения git — их не вернуть.'],
  [/\b(?:sudo|mkfs|diskutil\s+erase|format\s+[a-z]:|Format-Volume)\b/i,
    'Команда меняет систему или диск.'],
];

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object') return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function splitPath(filePath: string): { fileName: string; fileDir: string } {
  const parts = filePath.split(/[\\/]/);
  const fileName = parts.pop() || filePath;
  return { fileName, fileDir: parts.join(filePath.includes('\\') ? '\\' : '/') };
}

function firstWords(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 2).join(' ');
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}

export function describePermissionRequest(toolName: string, rawInput: unknown): PermissionDescription {
  const input = asRecord(rawInput);
  const filePath = str(input.file_path) || str(input.notebook_path) || str(input.path);

  switch (toolName) {
    case 'Edit':
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [input];
      return {
        kind: 'edit',
        title: 'Claude хочет изменить файл',
        ...splitPath(filePath),
        removed: edits.map((edit) => str(edit.old_string)).filter(Boolean).join('\n…\n'),
        added: edits.map((edit) => str(edit.new_string)).filter(Boolean).join('\n…\n'),
        alwaysLabel: 'Разрешать правки файлов',
      };
    }
    case 'Write':
      return {
        kind: 'write',
        title: 'Claude хочет записать файл',
        ...splitPath(filePath),
        added: str(input.content),
        alwaysLabel: 'Разрешать запись файлов',
      };
    case 'NotebookEdit':
      return { kind: 'edit', title: 'Claude хочет изменить блокнот', ...splitPath(filePath), added: str(input.new_source), alwaysLabel: 'Разрешать правки блокнотов' };
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command);
      const danger = DANGER_PATTERNS.find(([pattern]) => pattern.test(command))?.[1];
      return {
        kind: 'command',
        title: 'Claude хочет выполнить команду',
        code: command,
        note: str(input.description),
        danger,
        alwaysLabel: command ? `Разрешать «${firstWords(command)}…»` : 'Разрешать команды',
      };
    }
    case 'Read':
      return { kind: 'read', title: 'Claude хочет прочитать файл за пределами папки проекта', ...splitPath(filePath), alwaysLabel: 'Разрешать чтение' };
    case 'Glob':
    case 'Grep':
    case 'LS':
      return { kind: 'read', title: 'Claude хочет поискать файлы', code: [str(input.pattern), str(input.path)].filter(Boolean).join('  в  '), alwaysLabel: 'Разрешать поиск' };
    case 'WebFetch':
      return { kind: 'web', title: 'Claude хочет открыть страницу в интернете', code: str(input.url), note: str(input.prompt), alwaysLabel: 'Разрешать открывать страницы' };
    case 'WebSearch':
      return { kind: 'search', title: 'Claude хочет поискать в интернете', code: str(input.query), alwaysLabel: 'Разрешать поиск в интернете' };
    default:
      return { kind: 'other', title: `Claude хочет использовать «${toolName}»`, alwaysLabel: `Разрешать «${toolName}»` };
  }
}
