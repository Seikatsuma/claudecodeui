import * as fs from 'node:fs/promises';
import os from 'node:os';

import { providerModelsService } from '@/modules/providers/index.js';
import { providerTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createClaudeNativeCommandsService } from './claude-native-commands.service.js';
import { createCommandsRouter } from './commands.routes.js';

/** Commands router assembled for the authenticated server mount. */
export const commandsRoutes = createCommandsRouter({
  fileSystem: fs,
  homeDirectory: os.homedir,
  appRoot: findApplicationRoot(getModuleDirectory(import.meta.url)),
  models: providerModelsService,
  nativeCommands: createClaudeNativeCommandsService(),
  tokenUsage: providerTokenUsageService,
  runtime: {
    uptime: process.uptime,
    memoryUsage: process.memoryUsage,
    version: process.version,
    platform: process.platform,
    pid: process.pid,
  },
});
