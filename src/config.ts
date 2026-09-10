import * as fs from 'fs';
import * as path from 'path';
import { MigrateprConfig } from './types';

export const CONFIG_FILES = ['.migratepr.json', 'migratepr.config.json'];

const VALID_ENGINES = new Set(['rules', 'llm', 'auto']);

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
  return out;
}
