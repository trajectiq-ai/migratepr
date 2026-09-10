import * as fs from 'fs';
import { join } from 'path';
import { MigrationTrack } from '../types';
import { STRIPE_TRACKS } from './stripe';

export const TRACKS: MigrationTrack[] = [...STRIPE_TRACKS];

export function getTrack(id: string): MigrationTrack {
  const track = TRACKS.find(t => t.id === id);
  if (!track) {
    throw new Error(`Unknown migration track '${id}'. Available: ${TRACKS.map(t => t.id).join(', ')}`);
  }
  return track;
}

/** Extract the major version from a semver-ish range like '^12.18.0' or '13.11.0'. */
export function majorOf(versionSpec: string): number {
  const m = versionSpec.match(/(\d+)\./);
  if (!m) throw new Error(`Cannot parse version spec '${versionSpec}'`);
  return Number(m[1]);
}

export function detectTrack(vendor: string, installedVersionSpec: string): MigrationTrack | null {
  let major: number;
  try {
    major = majorOf(installedVersionSpec);
  } catch {
    return null;
  }
  return TRACKS.find(t => t.vendor === vendor && t.sdkFrom === major) ?? null;
}

/** Resolve the track for a repo: explicit id, or auto-detect from package.json. */
export function resolveTrackForRepo(repoPath: string, trackId?: string): MigrationTrack {
  if (trackId) return getTrack(trackId);
  const pkgPath = join(repoPath, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error(`No package.json found in ${repoPath}`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const spec = pkg.dependencies?.stripe ?? pkg.devDependencies?.stripe;
  if (!spec) {
    throw new Error(
      "stripe not found in package.json dependencies — the MVP supports repos that depend on 'stripe'",
    );
  }
  const track = detectTrack('stripe', spec);
  if (!track) {
    throw new Error(
      `No migration track for installed stripe@${spec}. Available: ` +
        TRACKS.map(t => `${t.id} (from v${t.sdkFrom})`).join(', '),
    );
  }
  return track;
}
