/* One-off e2e check: LLM rewrite through the local Ollama provider. */
const fs = require('fs');
const path = require('path');
const os = require('os');

const repo = path.join(os.tmpdir(), 'llm-e2e');
fs.rmSync(repo, { recursive: true, force: true });
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(repo, 'package.json'),
  JSON.stringify({ name: 'llm-e2e', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
);
fs.writeFileSync(
  path.join(repo, 'src', 'pay.js'),
  [
    "const Stripe = require('stripe');",
    "const stripe = new Stripe('sk_test_x', { apiVersion: '2022-11-15' });",
    '',
    'async function removeSub(id) {',
    '  return stripe.subscriptions.del(id);',
    '}',
    '',
    'module.exports = { removeSub };',
    '',
  ].join('\n'),
);

(async () => {
  const { Scanner } = require(path.join(__dirname, '..', 'dist', 'src', 'scanner'));
  const { getTrack } = require(path.join(__dirname, '..', 'dist', 'src', 'rules'));
  const { makeLlmProvider, llmRewrite } = require(path.join(__dirname, '..', 'dist', 'src', 'engine'));

  const track = getTrack('stripe-v12-to-v13');
  const scan = new Scanner().scan(repo, track);
  console.log('filesScanned:', scan.filesScanned, '| findings:', scan.findings.length);
  const f = scan.findings[0];
  console.log('finding:', f.ruleId, 'in', f.file + ':' + f.line);

  const provider = await makeLlmProvider();
  console.log('provider auto-selected:', provider.name);

  const rule = track.rules.find(r => r.id === f.ruleId);
  const result = await llmRewrite(provider, track, rule, f, repo);
  console.log('rewrite engine:', result.engine);
  console.log('=== file after local LLM rewrite ===');
  console.log(fs.readFileSync(path.join(repo, 'src', 'pay.js'), 'utf8'));
})().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
