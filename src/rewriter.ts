import * as fs from 'fs';
import * as path from 'path';
import {
  CallExpression,
  NewExpression,
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyAccessExpression,
  PropertyAssignment,
  SourceFile,
  SyntaxKind,
  VariableDeclaration,
} from 'ts-morph';
import {
  ApiVersionRule,
  Finding,
  MethodRenameRule,
  MockMethodKeyRule,
  ParamRenameRule,
  RewriteResult,
} from './types';

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Deterministic rule engine: rewrites findings using ts-morph AST edits and
 * writes the result back to disk. Every transformation here is mechanical and
 * reviewable; when a rule cannot be applied with certainty the rewriter
 * returns null and the finding is reported as skipped — never guessed.
 */
export class Rewriter {
  private readonly project: Project;

  constructor() {
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: { allowJs: true, esModuleInterop: true, skipLibCheck: true },
    });
  }

  apply(
    rule: MethodRenameRule | ParamRenameRule | ApiVersionRule | MockMethodKeyRule,
    finding: Finding,
    repoPath: string,
  ): RewriteResult | null {
    // Safety: never write outside the repo, and never touch package.json
    // (dependency changes go through the dedicated sdk-bump rule only).
    const repoRoot = path.resolve(repoPath);
    const absPath = path.resolve(repoRoot, finding.file);
    if (!absPath.startsWith(repoRoot + path.sep) || path.basename(absPath) === 'package.json') {
      return null;
    }
    if (!fs.existsSync(absPath)) return null;
    const source = this.project.createSourceFile(
      absPath.replace(/\\/g, '/'),
      fs.readFileSync(absPath, 'utf8'),
      { overwrite: true },
    );

    let after: string | null = null;
    if (rule.kind === 'method-rename') after = this.applyMethodRename(rule, finding, source);
    else if (rule.kind === 'param-rename') after = this.applyParamRename(rule, finding, source);
    else if (rule.kind === 'mock-method-key') after = this.applyMockKey(rule, finding, source);
    else after = this.applyApiVersion(rule, finding, source);

    if (after === null || after === finding.snippet) return null;
    source.saveSync();
    return {
      ruleId: rule.id,
      file: finding.file,
      line: finding.line,
      before: finding.snippet,
      after,
      engine: 'rules',
    };
  }

  private locateCall(source: SourceFile, finding: Finding): CallExpression | null {
    const matches = source
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(c => c.getText() === finding.snippet);
    if (matches.length === 0) return null;
    return matches.find(c => c.getStartLineNumber() === finding.line) ?? matches[0];
  }

  /** Value-position method reference, e.g. `.del.mockResolvedValue(...)` or
   *  `expect(stripe.subscriptions.del)…` — no call to the method itself. */
  private locatePropertyAccess(source: SourceFile, finding: Finding): PropertyAccessExpression | null {
    const matches = source
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .filter(c => c.getText() === finding.snippet);
    if (matches.length === 0) return null;
    return matches.find(c => c.getStartLineNumber() === finding.line) ?? matches[0];
  }

  private locateNew(source: SourceFile, finding: Finding): NewExpression | null {
    const matches = source
      .getDescendantsOfKind(SyntaxKind.NewExpression)
      .filter(c => c.getText() === finding.snippet);
    if (matches.length === 0) return null;
    return matches.find(c => c.getStartLineNumber() === finding.line) ?? matches[0];
  }

  private locateObjectLiteral(source: SourceFile, finding: Finding): ObjectLiteralExpression | null {
    const matches = source
      .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
      .filter(c => c.getText() === finding.snippet);
    if (matches.length === 0) return null;
    return matches.find(c => c.getStartLineNumber() === finding.line) ?? matches[0];
  }

  private applyMethodRename(
    rule: MethodRenameRule,
    finding: Finding,
    source: SourceFile,
  ): string | null {
    const call = this.locateCall(source, finding);
    if (call) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) {
        // Head bound through an alias (possibly imported cross-file), e.g.
        // `expect(delSub).toHaveBeenCalled()` — rename the alias declaration.
        return this.renameImportedHead(rule, finding, source);
      }
      const nameNode = expr.getNameNode();
      if (nameNode.getText() !== rule.from) return null;
      nameNode.replaceWithText(rule.to);
      return call.getText();
    }

    // Not a call: a value-position reference like
    // `stripe.subscriptions.del.mockResolvedValue(...)` or a binding
    // `const delSub = stripe.subscriptions.del`.
    const pae = this.locatePropertyAccess(source, finding);
    if (pae) {
      const nameNode = pae.getNameNode();
      if (nameNode.getText() !== rule.from) return null;
      nameNode.replaceWithText(rule.to);
      return pae.getText();
    }
    // Bare alias identifier bound to the method: rename its declaration.
    return this.renameImportedHead(rule, finding, source);
  }

  /**
   * Wrapper-module head: `createSession({ shipping_rates: ... })` in a file
   * that does `import { createSession } from './stripe'` (a local wrapper).
   * The rule targets the wrapper's method param, so the head identifier itself
   * is not renamed — only keys inside the call. Handled by param-rename; this
   * fallback renames a bare method head like `stripe.subscriptions.del`,
   * bound cross-file, by editing its *declaration* in this file.
   */
  private renameImportedHead(
    rule: MethodRenameRule,
    finding: Finding,
    source: SourceFile,
  ): string | null {
    // Example target: `const delSub = client.subscriptions.del;` → `.cancel`.
    for (const decl of source.getVariableDeclarations()) {
      if (!Node.isVariableDeclaration(decl)) continue;
      const init = decl.getInitializer();
      if (!init || !Node.isPropertyAccessExpression(init)) continue;
      if (!init.getText().endsWith(`.${rule.from}`)) continue;
      if (decl.getName() !== finding.snippet.trim()) continue;
      const nameNode = init.getNameNode();
      nameNode.replaceWithText(rule.to);
      return decl.getText();
    }
    return null;
  }

  /** Rename a resource-method key inside a detected test mock object. */
  private applyMockKey(
    rule: MockMethodKeyRule,
    finding: Finding,
    source: SourceFile,
  ): string | null {
    // The snippet is the inner PropertyAssignment (`del: jest.fn()` etc.).
    for (const prop of source.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (prop.getText() !== finding.snippet) continue;
      const parent = prop.getParent();
      if (!parent || !Node.isObjectLiteralExpression(parent)) continue;
      const outer = parent.getParent();
      if (!outer || !Node.isPropertyAssignment(outer)) continue;
      if (outer.getName() !== rule.resource) continue;
      prop.getNameNode().replaceWithText(rule.to);
      return prop.getText();
    }
    return null;
  }

  private applyParamRename(
    rule: ParamRenameRule,
    finding: Finding,
    source: SourceFile,
  ): string | null {
    const call = this.locateCall(source, finding);
    if (call) {
      for (const arg of call.getArguments()) {
        if (!Node.isObjectLiteralExpression(arg)) continue;
        const prop = arg.getProperty(rule.from);
        if (!prop || !Node.isPropertyAssignment(prop)) continue;
        if (!this.renameAndReshape(rule, prop)) return null;
        return call.getText();
      }
      return null;
    }

    // Assertion-context finding (test files): the snippet *is* the object
    // literal, e.g. expect.objectContaining({ shipping_rates: [...] }).
    const obj = this.locateObjectLiteral(source, finding);
    if (obj) {
      const prop = obj.getProperty(rule.from);
      if (!prop || !Node.isPropertyAssignment(prop)) return null;
      if (!this.renameAndReshape(rule, prop)) return null;
      return obj.getText();
    }
    return null;
  }

  /** Rename a param key and apply the deterministic value reshape, if any. */
  private renameAndReshape(rule: ParamRenameRule, prop: PropertyAssignment): boolean {
    prop.getNameNode().replaceWithText(
      IDENTIFIER_RE.test(rule.to) ? rule.to : `'${rule.to}'`,
    );
    if (rule.wrapTemplate) {
      const init = prop.getInitializer();
      if (!init || !Node.isArrayLiteralExpression(init)) return false; // abort rather than guess
      const wrapped = init
        .getElements()
        .map(el => rule.wrapTemplate!.replace('$0', el.getText()));
      init.replaceWithText(`[${wrapped.join(', ')}]`);
    }
    return true;
  }

  private applyApiVersion(
    rule: ApiVersionRule,
    finding: Finding,
    source: SourceFile,
  ): string | null {
    const ne = this.locateNew(source, finding);
    if (!ne) return null;
    const opts = ne.getArguments()[1];
    if (!opts || !Node.isObjectLiteralExpression(opts)) return null;
    const prop = opts.getProperty('apiVersion');
    if (!prop || !Node.isPropertyAssignment(prop)) return null;
    const init = prop.getInitializer();
    if (!init || !Node.isStringLiteral(init) || init.getLiteralText() !== rule.from) return null;
    init.replaceWithText(`'${rule.to}'`);
    return ne.getText();
  }
}
