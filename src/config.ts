import * as fs from 'fs';
import * as path from 'path';
import { MigrateprConfig, MigrationRule, MigrationTrack } from './types';

export const CONFIG_FILES = ['.migratepr.json', 'migratepr.config.json'];

const VALID_ENGINES = new Set(['rules', 'llm', 'auto']);
const VALID_RISKS = new Set(['mechanical', 'review-recommended', 'semantic']);

/**
 * Load the repo's .migratepr.json (first matching name wins). Never throws:
 * an invalid file is reported via `error` so the caller can fail loudly.
 */
export function loadConfig(repoPath: string): {
  config: MigrateprConfig;
  file?: string;
  error?: string;
} {
  for (const name of CONFIG_FILES) {
    const p = path.join(repoPath, name);
    if (!fs.existsSync(p)) continue;
    try {
      const config = validateConfig(JSON.parse(fs.readFileSync(p, 'utf8')));
      return { config, file: name };
    } catch (err) {
      return { config: {}, file: name, error: `invalid config: ${(err as Error).message}` };
    }
  }
  return { config: {} };
}

/** Structural validation with precise errors; unknown keys are ignored for forward-compat. */
export function validateConfig(raw: unknown): MigrateprConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config must be a JSON object');
  }
  const cfg = raw as Record<string, unknown>;
  const out: MigrateprConfig = {};

  if (cfg.track !== undefined) {
    if (typeof cfg.track !== 'string' || cfg.track.length === 0) {
      throw new Error("'track' must be a non-empty string");
    }
    out.track = cfg.track;
  }
  if (cfg.engine !== undefined) {
    if (typeof cfg.engine !== 'string' || !VALID_ENGINES.has(cfg.engine)) {
      throw new Error(`'engine' must be one of: ${[...VALID_ENGINES].join(', ')}`);
    }
    out.engine = cfg.engine as MigrateprConfig['engine'];
  }
  if (cfg.exclude !== undefined) {
    if (!Array.isArray(cfg.exclude) || cfg.exclude.some(e => typeof e !== 'string')) {
      throw new Error("'exclude' must be an array of strings");
    }
    out.exclude = cfg.exclude;
  }
  if (cfg.skipRules !== undefined) {
    if (!Array.isArray(cfg.skipRules) || cfg.skipRules.some(e => typeof e !== 'string')) {
      throw new Error("'skipRules' must be an array of strings");
    }
    out.skipRules = cfg.skipRules;
  }
  if (cfg.verifyCommand !== undefined) {
    if (typeof cfg.verifyCommand !== 'string' || cfg.verifyCommand.trim().length === 0) {
      throw new Error("'verifyCommand' must be a non-empty string");
    }
    out.verifyCommand = cfg.verifyCommand;
  }
  if (cfg.verifyTimeoutMs !== undefined) {
    if (
      typeof cfg.verifyTimeoutMs !== 'number' ||
      !Number.isFinite(cfg.verifyTimeoutMs) ||
      cfg.verifyTimeoutMs <= 0
    ) {
      throw new Error("'verifyTimeoutMs' must be a positive number");
    }
    out.verifyTimeoutMs = cfg.verifyTimeoutMs;
  }
  if (cfg.install !== undefined) {
    if (typeof cfg.install !== 'boolean') throw new Error("'install' must be a boolean");
    out.install = cfg.install;
  }
  if (cfg.prBase !== undefined) {
    if (typeof cfg.prBase !== 'string' || cfg.prBase.trim().length === 0) {
      throw new Error("'prBase' must be a non-empty string");
    }
    out.prBase = cfg.prBase;
  }
  if (cfg.tracks !== undefined) {
    if (!Array.isArray(cfg.tracks)) throw new Error("'tracks' must be an array of track objects");
    out.tracks = cfg.tracks.map(parseTrack);
  }
  if (cfg.verifyGates !== undefined) {
    if (!Array.isArray(cfg.verifyGates) || cfg.verifyGates.some(g => typeof g !== 'string' || g.trim().length === 0)) {
      throw new Error("'verifyGates' must be an array of npm script names (strings)");
    }
    out.verifyGates = cfg.verifyGates;
  }
  return out;
}

/* --------------------------- JSON rule DSL (tracks) --------------------------- */

export const RULE_KINDS = new Set([
  'method-rename',
  'method-move',
  'param-rename',
  'api-version',
  'mock-method-key',
  'client-constructor',
  'sdk-bump',
]);

/** Structural validation for a rule object from .migratepr.json. */
function parseRule(raw: unknown, trackId: string, index: number): MigrationRule {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`tracks[${trackId}].rules[${index}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== 'string' || !RULE_KINDS.has(kind)) {
    throw new Error(
      `tracks[${trackId}].rules[${index}].kind must be one of: ${[...RULE_KINDS].join(', ')}`,
    );
  }
  const str = (k: string, required = true): string => {
    const v = r[k];
    if (typeof v !== 'string' || v.trim().length === 0) {
      if (required) throw new Error(`tracks[${trackId}].rules[${index}].${k} must be a non-empty string`);
      return undefined as never;
    }
    return v;
  };
  const risk = str('risk');
  if (!VALID_RISKS.has(risk)) {
    throw new Error(`tracks[${trackId}].rules[${index}].risk must be one of: ${[...VALID_RISKS].join(', ')}`);
  }
  const ruleId =
    typeof r.id === 'string' && r.id.trim().length > 0
      ? r.id
      : `${trackId}:${str('name')}`;
  const base = {
    id: ruleId,
    kind: kind as MigrationRule['kind'],
    summary: str('summary'),
    guideUrl: str('guideUrl'),
    risk: risk as MigrationRule['risk'],
    ...(typeof r.needsLlm === 'boolean' ? { needsLlm: r.needsLlm } : {}),
    ...(typeof r.guideExcerpt === 'string' ? { guideExcerpt: r.guideExcerpt } : {}),
  };

  switch (kind) {
    case 'method-rename':
    case 'mock-method-key':
      return { ...base, resource: str('resource', false) ?? '', from: str('from'), to: str('to') } as MigrationRule;
    case 'method-move':
      return {
        ...base,
        fromResource: str('fromResource', false) ?? '',
        from: str('from'),
        to: str('to'),
      } as MigrationRule;
    case 'client-constructor':
      return { ...base, from: str('from'), to: str('to') } as MigrationRule;
    case 'param-rename':
      return {
        ...base,
        resource: str('resource', false) ?? '',
        ...(typeof r.method === 'string' ? { method: r.method } : {}),
        from: str('from'),
        to: str('to'),
        ...(typeof r.wrapTemplate === 'string' ? { wrapTemplate: r.wrapTemplate } : {}),
      } as MigrationRule;
    case 'api-version':
      return { ...base, from: str('from'), to: str('to') } as MigrationRule;
    case 'sdk-bump':
      return { ...base, packageName: str('packageName'), to: str('to') } as MigrationRule;
    default:
      throw new Error(`tracks[${trackId}].rules[${index}]: unsupported kind`);
  }
}

/**
 * Parse and validate one custom track from .migratepr.json (or rulegen
 * output). Exported so the AI rule generator reuses the exact same
 * structural validation as the config loader — no drift between formats.
 */
export function parseTrack(raw: unknown, trackIndex: number): MigrationTrack {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`tracks[${trackIndex}] must be an object`);
  }
  const t = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = t[k];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error(`tracks[${trackIndex}].${k} must be a non-empty string`);
    }
    return v;
  };
  const num = (k: string): number => {
    const v = t[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new Error(`tracks[${trackIndex}].${k} must be an integer`);
    }
    return v;
  };
  const id = str('id');
  const rulesRaw = t.rules;
  if (!Array.isArray(rulesRaw) || rulesRaw.length === 0) {
    throw new Error(`tracks[${trackIndex}].rules must be a non-empty array`);
  }
  const guideUrlsRaw = t.guideUrls;
  if (!Array.isArray(guideUrlsRaw) || guideUrlsRaw.length === 0 || guideUrlsRaw.some(u => typeof u !== 'string')) {
    throw new Error(`tracks[${trackIndex}].guideUrls must be an array of URLs`);
  }
  return {
    id,
    vendor: str('vendor'),
    sdkModule: str('sdkModule'),
    sdkFrom: num('sdkFrom'),
    sdkTo: num('sdkTo'),
    apiFrom: str('apiFrom'),
    apiTo: str('apiTo'),
    guideUrls: guideUrlsRaw as string[],
    rules: rulesRaw.map((r, i) => parseRule(r, id, i)),
  };
}
