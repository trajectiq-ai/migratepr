import { createHmac, timingSafeEqual } from 'crypto';

/**
 * GitHub App support (P2, self-hosted SaaS path): the code-level pieces that
 * turn MigratePR into a "watch upstream → auto-open test-verified PR" service
 * instead of a CLI you run on a schedule.
 *
 *   - buildAppManifest: a GitHub App manifest (paste into
 *     github.com/settings/apps/new to create the app in one step).
 *   - verifyWebhookSignature: HMAC-SHA256 verification of incoming webhooks
 *     (the app's webhook secret), timing-safe.
 *   - decideWebhookAction: the event router — given an event and payload,
 *     does this event warrant a migration run? This is where the
 *     self-maintaining loop decides, before any job is spawned.
 */

export interface AppManifestOptions {
  name: string;
  /** App homepage / setup URL. */
  url: string;
  /** Webhook URL (https). Omit for a manifest-only app you wire later. */
  hookUrl?: string;
  description?: string;
}

/**
 * GitHub App manifest (https://docs.github.com/en/apps/sharing-apps-and-migrations/using-github-apps/creating-a-github-app-using-a-url).
 * Scope is deliberately minimal: read code, open PRs, read metadata, write checks.
 * Events: push (default branch) and pull_request (to skip its own PRs).
 */
export function buildAppManifest(opts: AppManifestOptions): Record<string, unknown> {
  return {
    name: opts.name,
    url: opts.url,
    ...(opts.hookUrl ? { hook_attributes: { url: opts.hookUrl, active: true } } : {}),
    public: false,
    default_permissions: {
      contents: 'read',
      pull_requests: 'write',
      checks: 'write',
      metadata: 'read',
    },
    default_events: ['push', 'pull_request'],
    description:
      opts.description ??
      'MigratePR — automatically migrates code when a third-party SDK breaks its API: detect, rewrite, verify with the repo\'s own tests, open the PR.',
  };
}

/** Verify a GitHub webhook delivery: X-Hub-Signature-256 = sha256=<hex hmac>. */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || secret.length === 0) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const given = Buffer.from(signatureHeader);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export type WebhookEvent =
  | 'push'
  | 'pull_request'
  | 'check_run'
  | 'check_suite'
  | 'schedule'
  | 'unknown';

export interface WebhookDecision {
  migrate: boolean;
  reason: string;
  repoFullName?: string;
  defaultBranch?: string;
  /** 'main' | 'release' events only. */
  onDefaultBranch?: boolean;
}

function eventName(header: string | undefined): WebhookEvent {
  const e = (header ?? '').toLowerCase();
  if (['push', 'pull_request', 'check_run', 'check_suite', 'schedule'].includes(e)) {
    return e as WebhookEvent;
  }
  return 'unknown';
}

/** Commits/refs included in a push whose file list touches the SDK pins. */
function pushTouchesSdkFiles(payload: Record<string, unknown>): boolean {
  const sdkModules = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
  for (const commit of (payload.commits as Array<Record<string, unknown>> | undefined) ?? []) {
    for (const key of ['added', 'modified', 'removed'] as const) {
      const files = commit[key] as string[] | undefined;
      if (files && files.some(f => sdkModules.includes(f))) return true;
    }
  }
  return false;
}

/**
 * The self-maintaining decision: should this webhook trigger a migration run?
 *
 *   - push to the default branch that touches dependency files → yes
 *     (a pin moved or a new SDK version landed — the loop's trigger).
 *   - pull_request events → no (MigratePR never reacts to its own PRs; the
 *     CI workflow/check gates handle verification).
 *   - schedule → yes (cron-driven sweep, hosted equivalent of `watch`).
 *   - anything else → no.
 */
export function decideWebhookAction(
  rawEvent: string | undefined,
  payload: Record<string, unknown>,
): WebhookDecision {
  const event = eventName(rawEvent);
  const repo = (payload.repository as Record<string, unknown> | undefined) ?? {};
  const repoFullName = typeof repo.full_name === 'string' ? repo.full_name : undefined;
  const defaultBranch = typeof repo.default_branch === 'string' ? repo.default_branch : undefined;

  switch (event) {
    case 'push': {
      const ref = typeof payload.ref === 'string' ? payload.ref : '';
      const onDefaultBranch = defaultBranch ? ref === `refs/heads/${defaultBranch}` : false;
      if (!onDefaultBranch) {
        return {
          migrate: false,
          reason: `push to '${ref}' — not the default branch`,
          repoFullName,
          defaultBranch,
          onDefaultBranch,
        };
      }
      if (!pushTouchesSdkFiles(payload)) {
        return {
          migrate: false,
          reason: 'push to default branch but no dependency files changed',
          repoFullName,
          defaultBranch,
          onDefaultBranch,
        };
      }
      return {
        migrate: true,
        reason: 'dependency files changed on the default branch — re-check for migration',
        repoFullName,
        defaultBranch,
        onDefaultBranch,
      };
    }
    case 'pull_request':
      return {
        migrate: false,
        reason: 'pull_request events are ignored (the loop never reacts to its own PRs)',
        repoFullName,
        defaultBranch,
      };
    case 'schedule':
      return {
        migrate: true,
        reason: 'scheduled sweep — re-check all watched repos',
        repoFullName,
        defaultBranch,
      };
    default:
      return {
        migrate: false,
        reason: `event '${rawEvent ?? '?'}' is not a migration trigger`,
        repoFullName,
        defaultBranch,
      };
  }
}