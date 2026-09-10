/** Shared types for the MigratePR engine. */

export type RuleKind =
  | 'method-rename'
  | 'param-rename'
  | 'api-version'
  | 'mock-method-key'
  | 'sdk-bump';
export type RiskLevel = 'mechanical' | 'review-recommended' | 'semantic';

interface RuleBase {
  /** Globally unique, namespaced by track, e.g. 'stripe-v12-to-v13:subscriptions-del-cancel'. */
  id: string;
  /** Human-readable description used in PR bodies and LLM prompts. */
  summary: string;
  /** URL of the official vendor doc this rule was derived from. */
  guideUrl: string;
  /** Short verbatim excerpt from the guide, injected into LLM prompts. */
  guideExcerpt?: string;
  risk: RiskLevel;
  /**
   * True when the rule cannot be expressed deterministically and needs the
   * LLM engine (constrained by the official migration guide).
   */
  needsLlm?: boolean;
}

/** Rename an SDK method, e.g. stripe.subscriptions.del( → stripe.subscriptions.cancel( */
export interface MethodRenameRule extends RuleBase {
  kind: 'method-rename';
  /** Property chain preceding the method, e.g. 'subscriptions'. */
  resource: string;
  from: string;
  to: string;
}

/**
 * Rename a parameter inside an object-literal argument of a matching call,
 * with optional deterministic reshaping of its array value
 * (e.g. shipping_rates: [id] → shipping_options: [{ shipping_rate: id }]).
 */
export interface ParamRenameRule extends RuleBase {
  kind: 'param-rename';
  /** Property chain of the call, e.g. 'checkout.sessions'. */
  resource: string;
  /** Optional method name to constrain to, e.g. 'create'. */
  method?: string;
  from: string;
  to: string;
  /**
   * Optional deterministic value reshape. '$0' is replaced with each element
   * of the array initializer, e.g. '{ shipping_rate: $0 }'.
   */
  wrapTemplate?: string;
}

/** Update the pinned API version string, e.g. '2022-11-15' → '2023-08-16'. */
export interface ApiVersionRule extends RuleBase {
  kind: 'api-version';
  from: string;
  to: string;
}

/**
 * Rewrite a key inside a *test mock object* that imitates an SDK resource, e.g.
 * `const stripeMock = { subscriptions: { del: jest.fn() } }` → `cancel`.
 * Matching is constrained: the object must look like a mock (mock/jest/vi/test
 * signal nearby) and must not be passed to a `new Stripe(...)` style SDK entry.
 */
export interface MockMethodKeyRule extends RuleBase {
  kind: 'mock-method-key';
  /** Resource chain within the mock, e.g. 'subscriptions'. */
  resource: string;
  from: string;
  to: string;
}

/** Bump the SDK dependency range in package.json. */
export interface SdkBumpRule extends RuleBase {
  kind: 'sdk-bump';
  packageName: string;
  to: string;
}

export type MigrationRule =
  | MethodRenameRule
  | ParamRenameRule
  | ApiVersionRule
  | MockMethodKeyRule
  | SdkBumpRule;

/** Pluggable LLM backend for rewrites that rules cannot express. */
export interface LlmProvider {
  readonly name: string;
  complete(system: string, prompt: string): Promise<string>;
}

/** One vendor upgrade path, e.g. stripe-node v12 → v13. */
export interface MigrationTrack {
  id: string;
  /** Display name for PRs and logs, e.g. 'stripe' or 'express'. */
  vendor: string;
  /** npm package name that identifies the SDK (drives detection + scanning). */
  sdkModule: string;
  sdkFrom: number;
  sdkTo: number;
  apiFrom: string;
  apiTo: string;
  guideUrls: string[];
  rules: MigrationRule[];
}

/** A single affected call site found by the deterministic AST scanner. */
export interface Finding {
  id: string;
  ruleId: string;
  ruleKind: RuleKind;
  /** Repo-relative file path (posix separators). */
  file: string;
  line: number;
  column: number;
  snippet: string;
}

export interface RewriteResult {
  ruleId: string;
  file: string;
  line?: number;
  before: string;
  after: string;
  engine: 'rules' | 'llm' | 'package-json';
}

/** Result of the optional git/PR delivery step (used when dryRun is false). */
export interface GitOutcome {
  branch: string;
  committed: boolean;
  pushed: boolean;
  switchedBack: boolean;
  prUrl?: string;
  error?: string;
}

/**
 * Names exported by a module that should be treated as Stripe clients
 * (cross-file wrapper support). Produced by the scanner's pass 1.
 */
export interface ExportedClient {
  /** Repo-relative posix path of the exporting file. */
  file: string;
  /** Exported name to treat as a client. */
  name: string;
}

export interface ScanResult {
  findings: Finding[];
  filesScanned: number;
  /** Cross-file wrapper bindings the scanner inferred (informational + PR notes). */
  wrappers?: ExportedClient[];
}

export type VerifyStage = 'baseline' | 'post-migration';

export interface VerifyResult {
  ok: boolean;
  stage: VerifyStage;
  command: string;
  exitCode: number | null;
  /** Tail of combined stdout+stderr. */
  output: string;
  durationMs: number;
}

export interface PrPayload {
  branch: string;
  base: string;
  title: string;
  body: string;
}

export type MigrateStatus = 'migrated' | 'aborted' | 'diff-review';

export interface SkippedFinding {
  ruleId: string;
  reason: string;
}

export interface MigrateReport {
  status: MigrateStatus;
  git?: GitOutcome;
  reason?: string;
  /** Non-fatal log lines (installs, config notes, LLM fallbacks). */
  logs?: string[];
  track: MigrationTrack;
  findings: Finding[];
  rewrites: RewriteResult[];
  skipped: SkippedFinding[];
  baseline: VerifyResult | null;
  post: VerifyResult | null;
  diff: string | null;
  pr: PrPayload | null;
}

export interface VerifyFnInput {
  cwd: string;
  command: string;
  stage: VerifyStage;
}

/** Repository-level config file (.migratepr.json). All fields optional. */
export interface MigrateprConfig {
  $schema?: string;
  /**
   * Custom migration tracks defined in config (JSON rule DSL). Merged over
   * the built-in registry; custom tracks with the same id win. Rules are the
   * same shape as the TypeScript registry — no compilation needed.
   */
  tracks?: MigrationTrack[];
  /** Migration track id (e.g. 'stripe-v12-to-v13'). Default: auto-detect. */
  track?: string;
  /** Rewrite engine. Default: 'auto' (rules first, LLM for the rest). */
  engine?: 'rules' | 'llm' | 'auto';
  /** Glob-style scan exclusions, e.g. "generated/" or "*.gen.ts". */
  exclude?: string[];
  /** Rule ids to skip, e.g. rules awaiting a manual decision. */
  skipRules?: string[];
  /** Override the verify command (default: the package.json test script). */
  verifyCommand?: string;
  /** Per-run verify timeout in ms (default 600000). */
  verifyTimeoutMs?: number;
  /** Run `npm install` after dependency bumps (default false). */
  install?: boolean;
  /** Base branch for PRs (default: the branch HEAD had before delivery). */
  prBase?: string;
}

export interface MigrateOptions {
  repoPath: string;
  /** Explicit track id; otherwise auto-detected from package.json. */
  trackId?: string;
  engine?: 'rules' | 'llm' | 'auto';
  /** Default true: produce the PR payload locally without pushing/opening anything. */
  dryRun?: boolean;
  skipRuleIds?: string[];
  /** Test seam so unit tests can inject a fake verifier. */
  verifyFn?: (o: VerifyFnInput) => VerifyResult;
  /** Glob-style patterns excluded from scanning (posix rel paths). */
  excludePatterns?: string[];
  /** Run `npm install` after dependency bumps (default false). */
  install?: boolean;
  /** Override the verify command (defaults to the package.json test script). */
  verifyCommand?: string;
  /** Per-run timeout for each verify invocation in ms. */
  verifyTimeoutMs?: number;
  /** Refuse to migrate repos that are not git checkouts (default false). */
  requireGit?: boolean;
  /** Base branch override for PR delivery. */
  prBase?: string;
  /** Echo non-fatal progress lines into the report/logs. */
  verbose?: boolean;
}
