import * as fs from 'fs';
import { join } from 'path';
import { MigrationTrack, MigrateprConfig } from '../types';
import { STRIPE_TRACKS } from './stripe';
import { EXPRESS_TRACKS } from './express';
import { OPENAI_TRACKS } from './openai';

export const TRACKS: MigrationTrack[] = [...STRIPE_TRACKS, ...EXPRESS_TRACKS, ...OPENAI_TRACKS];

export function getTrack(id: string): MigrationTrack {
  const track = TRACKS.find(t => t.id === id);
  if (!track) {
    throw new Error(`Unknown migration track '${id}'. Available: ${TRACKS.map(t => t.id).join(', ')}`);
  }
  return track;
}

/** Merge custom config-defined tracks over the built-in registry. */
export function withCustomTracks(custom: MigrationTrack[] | undefined): MigrationTrack[] {
  if (!custom || custom.length === 0) return TRACKS;
  const byId = new Map(TRACKS.map(t => [t.id, t]));
  for (const t of custom) byId.set(t.id, t);
  return [...byId.values()];
}

/** Extract the major version from a semver-ish range like '^12.18.0' or '13.11.0'. */
export function majorOf(versionSpec: string): number {
  const m = versionSpec.match(/(\d+)\./);
  if (!m) throw new Error(`Cannot parse version spec '${versionSpec}'`);
  return Number(m[1]);
}

/**
 * Find the track whose SDK is installed at the "from" major version.
 * A repo pins stripe@^12 → the stripe v12 → v13 track.
 */
export function detectTrackForRepo(
  packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null,
  tracks: MigrationTrack[],
): MigrationTrack | null {
  if (!packageJson) return null;
  const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
  for (const track of tracks) {
    const spec = deps[track.sdkModule];
    if (!spec) continue;
    let major: number;
    try {
      major = majorOf(spec);
    } catch {
      continue;
    }
    if (major === track.sdkFrom) return track;
  }
  return null;
}

/**
 * Resolve the track for a repo: explicit id wins, then auto-detect from
 * package.json over the whole registry (built-in + config-defined tracks).
 */
export function resolveTrackForRepo(
  repoPath: string,
  trackId?: string,
  customTracks?: MigrationTrack[],
): MigrationTrack {
  const tracks = withCustomTracks(customTracks);
  if (trackId) {
    const track = tracks.find(t => t.id === trackId);
    if (!track) {
      throw new Error(`Unknown migration track '${trackId}'. Available: ${tracks.map(t => t.id).join(', ')}`);
    }
    return track;
  }
  const pkgPath = join(repoPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`No package.json found in ${repoPath} — cannot auto-detect a migration track`);
  }
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    throw new Error(`Could not parse package.json in ${repoPath}`);
  }
  const track = detectTrackForRepo(pkg, tracks);
  if (!track) {
    const supported = tracks.map(t => `${t.id} (${t.sdkModule}@${t.sdkFrom} → ${t.sdkTo})`).join(', ');
    throw new Error(
      `No migration track for the installed dependencies. Supported tracks: ${supported}. ` +
        'Define a custom track in .migratepr.json if yours is missing.',
    );
  }
  return track;
}

/** Config-aware variant used by the web app: auto-detect or explicit id. */
export function resolveTrack(
  repoPath: string,
  config: MigrateprConfig,
  trackId?: string,
): MigrationTrack {
  return resolveTrackForRepo(repoPath, trackId ?? config.track, config.tracks);
}