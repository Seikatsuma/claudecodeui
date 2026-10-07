import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  readObjectRecord,
  buildDevinChildEnv,
  readOptionalString,
  resolveDevinCliCommand,
  isAllowedDevinModel,
} from '@/shared/utils.js';
import { openDevinDatabase } from '@/modules/providers/list/devin/devin-sessions.provider.js';

const PROVIDER = 'devin' as const;

/** How long a freshly read `devin models list` catalog is trusted. */
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * Fallback catalog for when `devin models list` cannot run (CLI missing, not
 * authenticated). Values are model_uids the CLI catalog exposed in Oct 2026;
 * a stale subset is better than an empty picker.
 */
const FALLBACK_MODELS: ProviderModelOption[] = [
  { value: 'swe-2-high', label: 'SWE-2 High', description: 'Cognition SWE-2, high effort' },
  { value: 'swe-2-medium', label: 'SWE-2 Medium', description: 'Cognition SWE-2, medium effort' },
  { value: 'swe-2-max', label: 'SWE-2 Max', description: 'Cognition SWE-2, maximum effort' },
];

const DEFAULT_MODEL = 'swe-2-high';

let cachedCatalog: { at: number; models: ProviderModelOption[] } | null = null;

/** Parses `devin models list --format json` output into picker options. */
function parseDevinModelsCatalog(raw: unknown): ProviderModelOption[] {
  const root = readObjectRecord(raw);
  const families = Array.isArray(root?.families) ? root.families : [];
  const options: ProviderModelOption[] = [];

  for (const family of families) {
    const familyRecord = readObjectRecord(family);
    if (!familyRecord) {
      continue;
    }
    const familyLabel = readOptionalString(familyRecord.family_label)
      ?? readOptionalString(familyRecord.slug)
      ?? '';
    const variants = Array.isArray(familyRecord.variants) ? familyRecord.variants : [];
    for (const variant of variants) {
      const variantRecord = readObjectRecord(variant);
      const modelUid = readOptionalString(variantRecord?.model_uid);
      if (!modelUid) {
        continue;
      }
      const label = readOptionalString(variantRecord?.label) || modelUid;
      const description = readOptionalString(variantRecord?.description)
        ?? ([familyLabel, readOptionalString(variantRecord?.cost_summary)].filter(Boolean).join(' · ') || undefined);
      options.push({
        value: modelUid,
        label,
        description,
      });
    }
  }

  return options;
}

function readDevinModelsFromCli(): ProviderModelOption[] {
  const result = spawn.sync(resolveDevinCliCommand(), ['models', 'list', '--format', 'json'], {
    encoding: 'utf8',
    timeout: CATALOG_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: buildDevinChildEnv(),
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    return [];
  }
  try {
    return parseDevinModelsCatalog(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}

/** Reads the model stored on a Devin session row (`sessions.model`). */
function readSessionModel(sessionId: string): string | null {
  const db = openDevinDatabase();
  if (!db) {
    return null;
  }
  try {
    const row = db
      .prepare('SELECT model FROM sessions WHERE id = ?')
      .get(sessionId) as { model: string | null } | undefined;
    return readOptionalString(row?.model ?? undefined) ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * `~/.config/devin/config.json` → `agent.model` (the owner's configured
 * default). Exported for `devin-usage.ts`: the token counter resolves the
 * context window of CLI-started sessions whose `sessions.model` is empty.
 */
export function readConfiguredDefaultModel(): string | null {
  try {
    const configPath = path.join(os.homedir(), '.config', 'devin', 'config.json');
    const config: AnyRecord = JSON.parse(readFileSync(configPath, 'utf8'));
    return readOptionalString((readObjectRecord(config.agent) ?? {})?.model as string | undefined) ?? null;
  } catch {
    return null;
  }
}

export class DevinModelsProvider implements IProviderModels {
  /**
   * Live model catalog: `devin models list --format json` (cached for ten
   * minutes — it spawns a subprocess), falling back to a curated subset when
   * the CLI cannot answer.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    let models = cachedCatalog && Date.now() - cachedCatalog.at < CATALOG_CACHE_TTL_MS
      ? cachedCatalog.models
      : null;

    if (!models) {
      models = readDevinModelsFromCli();
      if (models.length > 0) {
        cachedCatalog = { at: Date.now(), models };
      }
    }

    // Only SWE-2 is allowed by the owner; the rest of the Devin catalog stays hidden.
    const allowed = (models ?? []).filter((option) => isAllowedDevinModel(option.value));
    const options = allowed.length > 0 ? allowed : FALLBACK_MODELS;
    const configuredDefault = readConfiguredDefaultModel();
    const defaultModel = configuredDefault && options.some((option) => option.value === configuredDefault)
      ? configuredDefault
      : DEFAULT_MODEL;

    return { OPTIONS: options, DEFAULT: defaultModel };
  }

  /**
   * The model Devin's own session row carries; used for sessions started in
   * the Devin CLI where the app never recorded a choice.
   */
  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    // Callers pass the app-facing session id — translate to Devin's own id
    // (for web-started sessions they differ; getSessionById covers both).
    const providerSessionId = sessionId
      ? (sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId)
      : null;
    const fromSession = providerSessionId ? readSessionModel(providerSessionId) : null;
    if (fromSession) {
      return { model: fromSession };
    }
    const catalog = await this.getSupportedModels();
    return { model: catalog.DEFAULT };
  }
}
