import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Project } from 'ts-morph';
import {
  Finding,
  LlmProvider,
  MigrationRule,
  MigrationTrack,
  RewriteResult,
} from './types';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiProvider } from './providers/openai';

/** Pick the first configured provider (Anthropic, then OpenAI). */
export function makeLlmProvider(): LlmProvider | null {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicProvider();
  if (process.env.OPENAI_API_KEY) return new OpenAiProvider();
  return null;
}

export function buildLlmPrompt(
  track: MigrationTrack,
  rule: MigrationRule,
  finding: Finding,
  source: string,
): { system: string; user: string } {
  const system = [
    'You are a precise code migration agent for third-party API upgrades.',
    'You will be given ONE file, ONE official migration rule, and the affected call site.',
    'Apply exactly that rule. Change nothing else: preserve formatting, comments,',
    'imports, and all unrelated code byte-for-byte wherever possible.',
    'Respond with ONLY the complete updated file content — no markdown fences, no commentary.',
  ].join(' ');

  const guidePart = [
    `Vendor: ${track.vendor}`,
    `Migration guide(s): ${track.guideUrls.join(', ')}`,
    `Rule: ${rule.id}`,
    `What changed: ${rule.summary}`,
    rule.guideExcerpt ? `Official guide excerpt:\n"""\n${rule.guideExcerpt}\n"""` : '',
    `Rule source: ${rule.guideUrl}`,
  ]
    .filter(Boolean)
    .join('\n');

  const user = [
    guidePart,
    '',
    `Affected call site in ${finding.file} at line ${finding.line}:`,
    finding.snippet,
    '',
    `=== FILE: ${finding.file} ===`,
    source,
    '',
    'Return the complete updated file now.',
  ].join('\n');

  return { system, user };
}

/** Unwrap a single markdown code fence if the model added one anyway. */
function unwrapFences(text: string): string {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

function looksLikeValidCode(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * LLM rewrite for rules that cannot be expressed deterministically
 * (needsLlm) or when the operator forces the llm engine. The output is
 * validated before it is written; invalid output becomes a skipped finding,
 * never a silent guess.
 */
export async function llmRewrite(
  provider: LlmProvider,
  track: MigrationTrack,
  rule: MigrationRule,
  finding: Finding,
  repoPath: string,
): Promise<RewriteResult> {
  const absPath = path.join(repoPath, finding.file);
  const before = fs.readFileSync(absPath, 'utf8');
  const { system, user } = buildLlmPrompt(track, rule, finding, before);

  const raw = await provider.complete(system, user);
  // Tolerate a single wrapper fence; reject everything else that smells like prose.
  const code = unwrapFences(raw);
  if (!looksLikeValidCode(code)) {
    throw new Error(`LLM output rejected (empty) for ${finding.file}:${finding.line}`);
  }

  // Validate that the required change actually happened before writing.
  const required: string[] = [];
  if (rule.kind === 'method-rename') required.push(`.${rule.to}(`);
  if (rule.kind === 'param-rename') required.push(rule.to);
  if (rule.kind === 'api-version') required.push(`'${rule.to}'`);
  if (required.some(token => !code.includes(token))) {
    throw new Error(
      `LLM output rejected (missing expected change) for ${finding.file}:${finding.line}`,
    );
  }

  // Syntax sanity check: transpileModule reports syntax diagnostics only
  // (no type-checking or module resolution), which is exactly the gate we want.
  const { diagnostics } = ts.transpileModule(code, {
    fileName: 'candidate.ts',
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length > 0) {
    const first = diagnostics[0];
    const line = first.file
      ? ts.getLineAndCharacterOfPosition(first.file, first.start ?? 0).line + 1
      : '?';
    throw new Error(
      `LLM output rejected (syntax error at line ${line}) for ${finding.file}:${finding.line}`,
    );
  }

  fs.writeFileSync(absPath, code, 'utf8');
  return {
    ruleId: rule.id,
    file: finding.file,
    line: finding.line,
    before: finding.snippet,
    after: `(whole-file rewrite by ${provider.name})`,
    engine: 'llm',
  };
}
