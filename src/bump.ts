import * as fs from 'fs';
import * as path from 'path';
import { RewriteResult, SdkBumpRule } from './types';

/**
 * Deterministically bump SDK dependency ranges in package.json for every
 * matching rule. Returns one rewrite result per changed dependency.
 */
export function bumpSdkDependency(rule: SdkBumpRule, repoPath: string): RewriteResult | null {
  const results = bumpSdkDependencies([rule], repoPath);
  return results[0] ?? null;
}

/** Multi-SDK variant: applies each rule in one package.json read/write pass. */
export function bumpSdkDependencies(rules: SdkBumpRule[], repoPath: string): RewriteResult[] {
  const pkgPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as Record<string, unknown>;

  const results: RewriteResult[] = [];
  for (const rule of rules) {
    let oldSpec: string | null = null;
    for (const section of ['dependencies', 'devDependencies']) {
      const deps = pkg[section];
      if (
        deps &&
        typeof deps === 'object' &&
        typeof (deps as Record<string, unknown>)[rule.packageName] === 'string'
      ) {
        oldSpec = (deps as Record<string, string>)[rule.packageName];
        (deps as Record<string, string>)[rule.packageName] = rule.to;
        break;
      }
    }
    if (!oldSpec || oldSpec === rule.to) continue;
    results.push({
      ruleId: rule.id,
      file: 'package.json',
      before: `${rule.packageName}@${oldSpec}`,
      after: `${rule.packageName}@${rule.to}`,
      engine: 'package-json',
    });
  }

  if (results.length === 0) return [];
  const out = JSON.stringify(pkg, null, 2) + (raw.endsWith('\n') ? '\n' : '');
  fs.writeFileSync(pkgPath, out, 'utf8');
  return results;
}
