import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

/**
 * Devin MCP file layout (verified against `devin mcp add --help` /
 * `devin mcp add` on CLI 3000.11):
 *
 * - `user`    → `~/.config/devin/mcp_config.json` (global; also the path the
 *               ACP handshake advertises as `mcpConfigPath`)
 * - `project` → `<workspace>/.devin/mcp_config.json` (committed)
 * - `local`   → `<workspace>/.devin/mcp_config.local.json` (gitignored)
 *
 * File shape — plain JSON:
 *   { "mcpServers": { "<name>": { "command", "args", "transport": "stdio" }
 *                            | { "url", "transport": "http"|"sse" } } }
 */
function resolveDevinConfigPath(scope: McpScope, workspacePath: string): string {
  if (scope === 'user') {
    return path.join(os.homedir(), '.config', 'devin', 'mcp_config.json');
  }
  const fileName = scope === 'local' ? 'mcp_config.local.json' : 'mcp_config.json';
  return path.join(workspacePath, '.devin', fileName);
}

async function readDevinConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeDevinConfig(filePath: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export class DevinMcpProvider extends McpProvider {
  constructor() {
    super('devin', ['user', 'project', 'local'], ['stdio', 'http', 'sse']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readDevinConfig(resolveDevinConfigPath(scope, workspacePath));
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = resolveDevinConfigPath(scope, workspacePath);
    const config = await readDevinConfig(filePath);
    config.mcpServers = servers;
    await writeDevinConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }
      return {
        command: input.command.trim(),
        ...(input.args?.length ? { args: input.args } : {}),
        ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
        transport: 'stdio',
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for remote MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }
    return {
      url: input.url.trim(),
      transport: input.transport === 'sse' ? 'sse' : 'http',
      ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    const transport = readOptionalString(config.transport);
    const command = readOptionalString(config.command);
    if (transport === 'stdio' || command) {
      if (!command) {
        return null;
      }
      return {
        provider: 'devin',
        name,
        scope,
        transport: 'stdio',
        command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
      };
    }

    const url = readOptionalString(config.url);
    if (url) {
      return {
        provider: 'devin',
        name,
        scope,
        transport: transport === 'sse' ? 'sse' : 'http',
        url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
