import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrate } from './migrate';
import { bold, dim, green, red, yellow } from './ansi';

/**
 * End-to-end demo: runs the full pipeline against a throwaway COPY of
 * examples/checkout-demo, a repo whose test suite is green on the old Stripe
 * API and would be red on the new one. The example itself is never mutated,
 * so the demo is repeatable. Dry run: no branch, no push.
 */
async function main(): Promise<void> {
  const candidates = [
    path.resolve(process.cwd(), 'examples', 'checkout-demo'),
    path.resolve(__dirname, '..', '..', 'examples', 'checkout-demo'),
  ];
  const exampleDir = candidates.find(p => fs.existsSync(p));
  if (!exampleDir) {
    console.error(red(`Demo repo missing (tried: ${candidates.join(', ')})`));
    process.exitCode = 1;
    return;
  }

  // Work on a disposable copy so the committed example stays pristine.
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'migratepr-demo-'));
  const target = path.join(repoPath, 'checkout-demo');
  fs.cpSync(exampleDir, target, { recursive: true });

  console.log(bold('MigratePR demo — Stripe v12 → v13'));
  console.log(dim(`Target: copy of examples/checkout-demo at ${target}`));
  console.log(dim('Dry run: no branch, no push, nothing leaves the machine\n'));

  try {
    const report = await migrate({ repoPath: target, engine: 'rules', dryRun: true });

    console.log(`Track:     ${report.track.id}`);
    console.log(
      `Status:    ${report.status === 'migrated' ? green(report.status) : yellow(report.status)}`,
    );
    console.log(`Findings:  ${report.findings.length}`);
    console.log('');

    for (const f of report.findings) {
      console.log(dim(`  found ${f.file}:${f.line} — ${f.ruleId}`));
    }
    console.log('');

    for (const r of report.rewrites) {
      const loc = r.line ? `${r.file}:${r.line}` : r.file;
      console.log(green('✔') + ` ${loc} [${r.engine}]`);
      console.log(dim('    before: ') + r.before.split('\n').join(' ').slice(0, 140));
      console.log(dim('    after:  ') + r.after.split('\n').join(' ').slice(0, 140));
    }

    if (report.baseline) {
      console.log(
        `\nBaseline tests: ${report.baseline.ok ? green('pass') : red('fail')} (${report.baseline.durationMs}ms)`,
      );
    }
    if (report.post) {
      console.log(
        `Post tests:     ${report.post.ok ? green('pass') : red('fail')} (${report.post.durationMs}ms)`,
      );
    }

    if (report.status !== 'migrated') {
      console.log(`\n${red('Result: ' + report.status + ' — ' + (report.reason ?? ''))}`);
      process.exitCode = 1;
      return;
    }

    if (report.pr) {
      console.log('\n' + bold('Generated PR payload'));
      console.log(`branch: ${report.pr.branch}`);
      console.log(`title:  ${report.pr.title}\n`);
      console.log(report.pr.body);
    }
    console.log(
      '\n' + green('Demo complete: detection and rewrites were deterministic; tests gated the PR.'),
    );
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
