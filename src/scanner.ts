import * as fs from 'fs';
import * as path from 'path';
import {
  CallExpression,
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyAccessExpression,
  SourceFile,
  SyntaxKind,
} from 'ts-morph';
import {
  ExportedClient,
  Finding,
  MethodRenameRule,
  MigrationTrack,
  MockMethodKeyRule,
  ParamRenameRule,
  ScanResult,
} from './types';
import { globToRegExp, isExcluded } from './glob';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'artifacts',
  '.next',
]);
/** Module-resolution candidates for a relative import like './stripeClient'. */
const MODULE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
/** Heuristic markers that an object literal is a hand-written SDK test double. */
const MOCK_SIGNAL = /\b(mock|jest|vi\.|vitest|sinon|fake|stub|testdouble|__mocks__|nock)\b/i;

interface ResolveContext {
  classNames: Set<string>;
  aliases: Map<string, string[]>;
  /** local name → module specifier for this file's imports. */
  imports: Map<string, string>;
  /** module specifier (relative) → exported wrapper chains, if known. */
  resolveModuleExports: (moduleSpecifier: string) => Map<string, string[]> | undefined;
}

/** Per-file analysis state produced by pass 1 and refined by augmentation. */
interface FileInfo {
  file: SourceFile;
  rel: string;
  classNames: Set<string>;
  aliases: Map<string, string[]>;
  imports: Map<string, string>;
  exportFactories: Map<string, string[]>;
}

/**
 * Deterministic AST scanner (ts-morph), two passes over the repo:
 *
 *   Pass 1 — per file: collect Stripe bindings (imports, `new Stripe`,
 *   require, aliases, class-property clients) and exported client
 *   factories/wrappers (`export const stripe = new Stripe(...)`).
 *
 *   Pass 2 — per file: resolve every call chain to Stripe resources —
 *   including chains that start in *another file* via imported wrapper
 *   modules — and detect hand-written SDK mocks implementing removed
 *   methods. No LLM involved: this step must never hallucinate.
 */
export class Scanner {
  private readonly project: Project;
  /** Absolute posix file path → exported wrapper chains (pass 1 output). */
  private exportedModules = new Map<string, Map<string, string[]>>();

  constructor() {
    this.project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: { allowJs: true, esModuleInterop: true, skipLibCheck: true },
    });
  }

  scan(repoPath: string, track: MigrationTrack, excludePatterns: string[] = []): ScanResult {
    // Normalize: module resolution below must compare like-for-like absolute
    // paths regardless of the process working directory.
    repoPath = path.resolve(repoPath);
    const methodRules = track.rules.filter(
      (r): r is MethodRenameRule => r.kind === 'method-rename',
    );
    const paramRules = track.rules.filter((r): r is ParamRenameRule => r.kind === 'param-rename');
    const apiVersionRules = track.rules.filter(r => r.kind === 'api-version');
    const mockRules = track.rules.filter((r): r is MockMethodKeyRule => r.kind === 'mock-method-key');
    // A trailing '/' means "this directory" — expand it to include contents.
    const excludes = excludePatterns.map(p =>
      p.endsWith('/') ? globToRegExp(`${p}**`) : globToRegExp(p),
    );

    const relPosix = (p: string): string => path.relative(repoPath, p).replace(/\\/g, '/');
    const files = this.listSourceFiles(repoPath).filter(f => !isExcluded(relPosix(f), excludes));
    const findings: Finding[] = [];
    let counter = 0;
    const nextId = (): string => `f${++counter}`;

    this.exportedModules.clear();

    /* ------------------------------- pass 1 ------------------------------- */
    const infos: FileInfo[] = [];
    for (const file of files) {
      if (!fs.existsSync(file)) continue; // may have been removed mid-scan
      const rel = relPosix(file);
      const source = this.project.createSourceFile(
        file.replace(/\\/g, '/'),
        fs.readFileSync(file, 'utf8'),
        { overwrite: true },
      );
      const { classNames, aliases } = this.collectSdkBindings(source, track.sdkModule);
      const imports = this.collectImports(source);
      const exportFactories = this.collectExportedFactories(source, classNames, aliases);
      infos.push({ file: source, rel, classNames, aliases, imports, exportFactories });
      if (exportFactories.size > 0) {
        this.exportedModules.set(source.getFilePath(), exportFactories);
      }
    }

    // Augmentation pass: resolve bindings that flow through *relative*
    // wrapper modules — `const { stripe } = require('./stripeClient')` —
    // now that every module's exports are known. Then recompute aliases
    // and class members against the enlarged client set.
    for (const info of infos) {
      this.augmentBindings(info);
    }

    /* ------------------------------- pass 2 ------------------------------- */
    const wrappers: ExportedClient[] = [];
    for (const info of infos) {
      const ctx: ResolveContext = {
        classNames: info.classNames,
        aliases: info.aliases,
        imports: info.imports,
        resolveModuleExports: spec => this.resolveRelativeModule(spec, info.file.getFilePath()),
      };

      for (const call of info.file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const chain = this.resolveChain(call.getExpression(), ctx);
        // Allow single-segment chains: for client-bound resources the resource
        // is '' (e.g. `app.del(...)` where `app` itself is the SDK client).
        if (!chain || chain.length === 0) continue;
        const resource = chain.slice(0, -1).join('.');
        const method = chain[chain.length - 1];

        for (const rule of methodRules) {
          if (rule.resource === resource && rule.from === method) {
            findings.push(this.makeFinding(nextId(), rule.id, rule.kind, info.rel, call, info.file));
          }
        }
        for (const rule of paramRules) {
          if (rule.resource !== resource) continue;
          if (rule.method !== undefined && rule.method !== method) continue;
          const hasParam = call
            .getArguments()
            .some(arg => Node.isObjectLiteralExpression(arg) && !!arg.getProperty(rule.from));
          if (hasParam) {
            findings.push(this.makeFinding(nextId(), rule.id, rule.kind, info.rel, call, info.file));
          }
        }
      }

      for (const ne of info.file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (!info.classNames.has(ne.getExpression().getText())) continue;
        const opts = ne.getArguments()[1];
        if (!opts || !Node.isObjectLiteralExpression(opts)) continue;
        const prop = opts.getProperty('apiVersion');
        if (!prop || !Node.isPropertyAssignment(prop)) continue;
        const init = prop.getInitializer();
        if (!init || !Node.isStringLiteral(init)) continue;
        const rule = apiVersionRules.find(r => r.from === init.getLiteralText());
        if (rule) {
          findings.push(this.makeFinding(nextId(), rule.id, rule.kind, info.rel, ne, info.file));
        }
      }

      // Value-position method references (not calls): mock setup
      // (`stripe.subscriptions.del.mockResolvedValue(...)` — reported at the
      // inner `stripe.subscriptions.del`), assertions
      // (`expect(stripe.subscriptions.del).toHaveBeenCalledWith(...)`), and
      // bindings (`const delSub = stripe.subscriptions.del`).
      for (const pae of info.file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const parent = pae.getParent();
        if (parent && Node.isCallExpression(parent) && parent.getExpression() === pae) continue;
        const chain = this.resolveChain(pae, ctx);
        if (!chain || chain.length === 0) continue;
        const resource = chain.slice(0, -1).join('.');
        const method = chain[chain.length - 1];
        for (const rule of methodRules) {
          if (rule.resource === resource && rule.from === method) {
            findings.push(this.makeFinding(nextId(), rule.id, rule.kind, info.rel, pae, info.file));
            break;
          }
        }
      }

      // Test assertions encode the *old* API contract
      // (`expect(...).toHaveBeenCalledWith(expect.objectContaining({
      // shipping_rates: [...] }))`); after migration they must assert the
      // new one or the suite fails. In test files, report object literals
      // inside expect(...) chains that carry a param-rename key.
      if (this.isTestFile(info.rel)) {
        for (const rule of paramRules) {
          for (const obj of this.findAssertionObjects(info.file, rule)) {
            findings.push(
              this.makeFinding(nextId(), rule.id, rule.kind, info.rel, obj, info.file),
            );
          }
        }
      }

      for (const rule of mockRules) {
        for (const key of this.findMockMethodKeys(info.file, rule, info.classNames)) {
          findings.push(
            this.makeFinding(nextId(), rule.id, rule.kind, info.rel, key, info.file),
          );
        }
      }

      for (const name of info.exportFactories.keys()) {
        wrappers.push({ file: info.rel, name });
      }
    }

    return { findings, filesScanned: files.length, wrappers };
  }

  /**
   * Identifiers bound to the SDK client of the current track's module, plus
   * local aliases of its members. Vendor-agnostic: whatever module the track
   * pins (`stripe`, `express`, …) drives both import matching and the
   * factory bindings (`const app = express()`).
   */
  private collectSdkBindings(source: SourceFile, sdkModule: string): {
    classNames: Set<string>;
    aliases: Map<string, string[]>;
  } {
    const classNames = new Set<string>();
    const aliases = new Map<string, string[]>();

    for (const d of source.getImportDeclarations()) {
      if (d.getModuleSpecifierValue() !== sdkModule) continue;
      const di = d.getDefaultImport();
      if (di) classNames.add(di.getText());
      const ni = d.getNamespaceImport();
      if (ni) classNames.add(ni.getText());
      for (const named of d.getNamedImports()) {
        if (named.getNameNode().getText() === 'default') {
          classNames.add(named.getAliasNode()?.getText() ?? 'default');
        }
      }
    }

    for (const stmt of source.getVariableStatements()) {
      for (const decl of stmt.getDeclarationList().getDeclarations()) {
        if (!Node.isIdentifier(decl.getNameNode())) continue;
        const name = decl.getName();
        const init = decl.getInitializer();
        if (!init) continue;

        if (Node.isNewExpression(init)) {
          // `const stripe = new Stripe(key, {…})`
          if (classNames.has(init.getExpression().getText())) classNames.add(name);
          continue;
        }
        if (Node.isCallExpression(init) && init.getExpression().getText() === 'require') {
          const arg = init.getArguments()[0];
          if (arg && Node.isStringLiteral(arg) && arg.getLiteralText() === sdkModule) {
            classNames.add(name);
          }
          continue;
        }
        if (Node.isCallExpression(init)) {
          // `const app = express()` — factory call from the SDK module.
          if (classNames.has(init.getExpression().getText())) classNames.add(name);
          continue;
        }
      }
    }

    this.collectAliases(source, classNames, aliases);
    this.collectClientMembers(source, classNames);
    return { classNames, aliases };
  }

  /**
   * Cross-file pass: bind destructured requires of known wrapper modules
   * (`const { stripe } = require('./stripeClient')`) to the wrapper's export
   * chain, then recompute aliases and class members. Mutates `info`.
   */
  private augmentBindings(info: FileInfo): void {
    let changed = false;
    for (const [localName, mod] of info.imports) {
      if (!mod.startsWith('./') && !mod.startsWith('../')) continue;
      const exported = this.resolveRelativeModule(mod, info.file.getFilePath());
      const chain = exported?.get(localName);
      if (!chain) continue;
      if (chain.length === 0) info.classNames.add(localName);
      else info.aliases.set(localName, chain);
      changed = true;
    }
    if (!changed) return;
    info.aliases.clear();
    this.collectAliases(info.file, info.classNames, info.aliases);
    this.collectClientMembers(info.file, info.classNames);
    const factories = this.collectExportedFactories(info.file, info.classNames, info.aliases);
    if (factories.size > 0) {
      info.exportFactories = factories;
      this.exportedModules.set(info.file.getFilePath(), factories);
    }
  }

  /** Aliases: `const createSession = stripe.checkout.sessions.create`. */
  private collectAliases(
    source: SourceFile,
    classNames: Set<string>,
    aliases: Map<string, string[]>,
  ): void {
    const ctx: ResolveContext = {
      classNames,
      aliases,
      imports: new Map(),
      resolveModuleExports: () => undefined,
    };
    for (const stmt of source.getVariableStatements()) {
      for (const decl of stmt.getDeclarationList().getDeclarations()) {
        if (!Node.isIdentifier(decl.getNameNode())) continue;
        const init = decl.getInitializer();
        if (!init || !Node.isPropertyAccessExpression(init)) continue;
        const chain = this.resolveChain(init, ctx);
        if (chain) aliases.set(decl.getName(), chain);
      }
    }
  }

  /**
   * Client members on classes: property initializers
   * (`client = new Stripe(key)`) and constructor params defaulting to a
   * client (`constructor(client = stripe)`), enabling `this.client` chains.
   */
  private collectClientMembers(source: SourceFile, classNames: Set<string>): void {
    for (const cls of source.getClasses()) {
      for (const prop of cls.getProperties()) {
        const init = prop.getInitializer();
        if (init && Node.isNewExpression(init) && classNames.has(init.getExpression().getText())) {
          classNames.add(prop.getName());
        }
      }
      for (const ctor of cls.getConstructors()) {
        for (const p of ctor.getParameters()) {
          const init = p.getInitializer();
          if (init && Node.isIdentifier(init) && classNames.has(init.getText())) {
            classNames.add(p.getName());
          }
        }
      }
    }
  }

  /** Local name → module specifier for imports and require()/destructures. */
  private collectImports(source: SourceFile): Map<string, string> {
    const imports = new Map<string, string>();
    for (const d of source.getImportDeclarations()) {
      const mod = d.getModuleSpecifierValue();
      const di = d.getDefaultImport();
      if (di) imports.set(di.getText(), mod);
      const ni = d.getNamespaceImport();
      if (ni) imports.set(ni.getText(), mod);
      for (const named of d.getNamedImports()) {
        imports.set(named.getAliasNode()?.getText() ?? named.getNameNode().getText(), mod);
      }
    }
    for (const stmt of source.getVariableStatements()) {
      for (const decl of stmt.getDeclarationList().getDeclarations()) {
        const init = decl.getInitializer();
        if (!init || !Node.isCallExpression(init)) continue;
        if (init.getExpression().getText() !== 'require') continue;
        const arg = init.getArguments()[0];
        if (!arg || !Node.isStringLiteral(arg)) continue;
        const mod = arg.getLiteralText();
        const nameNode = decl.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          imports.set(nameNode.getText(), mod);
        } else if (Node.isObjectBindingPattern(nameNode)) {
          for (const el of nameNode.getElements()) {
            imports.set(el.getNameNode().getText(), mod);
          }
        }
      }
    }
    return imports;
  }

  /**
   * Exported Stripe clients/wrappers of a module:
   *  - `export const stripe = new Stripe(key)`           → []
   *  - `export const createSession = stripe.checkout...` → resolved chain
   *  - `module.exports = { getStripe }` / `exports.getStripe = getStripe`
   */
  private collectExportedFactories(
    source: SourceFile,
    classNames: Set<string>,
    aliases: Map<string, string[]>,
  ): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const ctx: ResolveContext = {
      classNames,
      aliases,
      imports: new Map(),
      resolveModuleExports: () => undefined,
    };
    const chainOf = (init: Node): string[] | null => {
      if (Node.isPropertyAccessExpression(init)) return this.resolveChain(init, ctx);
      if (Node.isNewExpression(init) && classNames.has(init.getExpression().getText())) return [];
      if (Node.isIdentifier(init)) {
        if (classNames.has(init.getText())) return [];
        return aliases.get(init.getText()) ?? null;
      }
      return null;
    };

    for (const stmt of source.getVariableStatements()) {
      if (!stmt.hasExportKeyword()) continue;
      for (const decl of stmt.getDeclarationList().getDeclarations()) {
        if (!Node.isIdentifier(decl.getNameNode())) continue;
        const init = decl.getInitializer();
        if (!init) continue;
        const chain = chainOf(init);
        if (chain) out.set(decl.getName(), chain);
      }
    }

    for (const expr of source.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (expr.getOperatorToken().getText() !== '=') continue;
      const left = expr.getLeft();
      const right = expr.getRight();
      if (left.getText() === 'module.exports' || left.getText() === 'exports') {
        if (!Node.isObjectLiteralExpression(right)) continue;
        for (const prop of right.getProperties()) {
          let name: string | undefined;
          let chain: string[] | null = null;
          if (Node.isPropertyAssignment(prop)) {
            const init = prop.getInitializer();
            if (init) chain = chainOf(init);
            name = prop.getName();
          } else if (Node.isShorthandPropertyAssignment(prop)) {
            // `module.exports = { stripe, createSession }`
            name = prop.getName();
            if (classNames.has(name)) chain = [];
            else chain = aliases.get(name) ?? null;
          }
          if (name && chain) out.set(name, chain);
        }
        continue;
      }
      if (
        Node.isPropertyAccessExpression(left) &&
        left.getExpression().getText() === 'exports'
      ) {
        const chain = chainOf(right);
        if (chain) out.set(left.getName(), chain);
      }
    }
    return out;
  }

  /** Resolve a relative module specifier to a known wrapper-module path. */
  private resolveRelativeModule(
    specifier: string,
    fromFile: string,
  ): Map<string, string[]> | undefined {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
    const base = path.resolve(path.dirname(fromFile), specifier);
    for (const suffix of MODULE_SUFFIXES) {
      for (const candidate of [
        `${base}${suffix}`,
        path.join(base, `index${suffix}`),
      ]) {
        const key = candidate.replace(/\\/g, '/');
        const found = this.exportedModules.get(key);
        if (found) return found;
      }
    }
    return undefined;
  }

  /** Where `head` (an identifier) was imported from, if anywhere. */
  private importedFrom(head: Node, ctx: ResolveContext): { name: string; module: string } | null {
    if (!Node.isIdentifier(head)) return null;
    const mod = ctx.imports.get(head.getText());
    return mod ? { name: head.getText(), module: mod } : null;
  }

  /**
   * Resolve a property-access expression to the member chain behind a Stripe
   * client, e.g. `stripe.checkout.sessions.create` → ['checkout','sessions','create'].
   * Understands local aliases, `this.client` chains, and — crucially for real
   * codebases — heads imported from another module that exports a Stripe
   * client or wrapper (cross-file resolution). Returns null when the head
   * cannot be tied to the SDK.
   */
  private resolveChain(expr: Node, ctx: ResolveContext): string[] | null {
    if (Node.isIdentifier(expr)) {
      return ctx.aliases.get(expr.getText()) ?? null;
    }
    if (!Node.isPropertyAccessExpression(expr)) return null;

    const segments: string[] = [];
    let current: Node = expr;
    // PropertyAccessChain nodes (from optional chaining `a?.b`) share the
    // compiler shape of PropertyAccessExpression, so unwrap both uniformly.
    while (
      Node.isPropertyAccessExpression(current) ||
      current.getKindName() === 'PropertyAccessChain'
    ) {
      const pae = current as unknown as PropertyAccessExpression;
      segments.unshift(pae.getName());
      current = pae.getExpression();
    }
    const head = current.getText();
    // `this.client.subscriptions.del(...)` with `client = new Stripe(...)`:
    // the head is `this`, so match the next segment against client bindings.
    if (head === 'this' && segments.length > 0) {
      const first = segments[0];
      return ctx.classNames.has(first) ? segments.slice(1) : null;
    }
    if (ctx.classNames.has(head)) return segments;
    const alias = ctx.aliases.get(head);
    if (alias) return [...alias, ...segments];

    // Cross-file: the head (or a factory call head like `getStripe()`) comes
    // from a local wrapper module scanned in pass 1.
    const factoryHead = Node.isCallExpression(current)
      ? this.importedFrom(current.getExpression(), ctx)
      : this.importedFrom(current, ctx);
    if (factoryHead) {
      const exported = ctx.resolveModuleExports(factoryHead.module);
      const chain = exported?.get(factoryHead.name);
      if (chain) return [...chain, ...segments];
    }
    return null;
  }

  /** Test files: conventional dirs, *.test.*, *.spec.*. */
  private isTestFile(relPosixPath: string): boolean {
    return (
      /(^|\/)(tests?|__tests__|__mocks__)\//.test(relPosixPath) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPosixPath)
    );
  }

  /**
   * Object literals inside expect(...) assertion chains that carry the
   * rule's `from` key, e.g. expect.objectContaining({ shipping_rates: [...] }).
   */
  private findAssertionObjects(source: SourceFile, rule: ParamRenameRule): Node[] {
    const hits: Node[] = [];
    for (const obj of source.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      if (!obj.getProperty(rule.from)) continue;
      let ancestor: Node | undefined = obj.getParent();
      let inAssertion = false;
      while (ancestor) {
        if (Node.isCallExpression(ancestor)) {
          const exprText = ancestor.getExpression().getText();
          if (/^expect\b/.test(exprText)) {
            inAssertion = true;
            break;
          }
        }
        ancestor = ancestor.getParent();
      }
      if (inAssertion) hits.push(obj);
    }
    return hits;
  }

  /**
   * Find mock method keys to rewrite, e.g. `subscriptions: { del: vi.fn() }`
   * inside a test double. Only objects that look like mocks qualify: a mock
   * signal (mock/jest/vi/…) in the surrounding lines, and the object must not
   * be nested inside a real SDK construction (`new Stripe({...})`).
   */
  private findMockMethodKeys(
    source: SourceFile,
    rule: MockMethodKeyRule,
    classNames: Set<string>,
  ): Node[] {
    const hits: Node[] = [];
    for (const obj of source.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      // Never rewrite objects passed to a real SDK client construction.
      let ancestor: Node | undefined = obj.getParent();
      let insideSdkConstruction = false;
      while (ancestor) {
        if (Node.isNewExpression(ancestor) && classNames.has(ancestor.getExpression().getText())) {
          insideSdkConstruction = true;
          break;
        }
        ancestor = ancestor.getParent();
      }
      if (insideSdkConstruction) continue;

      // Mock-signal gate over a few surrounding lines.
      const allLines = source.getEndLineNumber() > 0 ? source.getText().split('\n') : [];
      const line = obj.getStartLineNumber();
      const windowText = allLines.slice(Math.max(0, line - 3), line + 3).join('\n');
      if (!MOCK_SIGNAL.test(windowText)) continue;

      for (const prop of obj.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) continue;
        if (rule.resource === '') {
          // Resource-less mock (e.g. `const app = { del: jest.fn() }`): the
          // object literal itself is the resource; match the method key directly.
          if (prop.getName() === rule.from) hits.push(prop);
          continue;
        }
        if (prop.getName() !== rule.resource) continue;
        const init = prop.getInitializer();
        if (!init || !Node.isObjectLiteralExpression(init)) continue;
        for (const inner of init.getProperties()) {
          if (Node.isPropertyAssignment(inner) && inner.getName() === rule.from) {
            hits.push(inner);
          }
        }
      }
    }
    return hits;
  }

  private makeFinding(
    id: string,
    ruleId: string,
    ruleKind: Finding['ruleKind'],
    relFile: string,
    node: Node,
    source: SourceFile,
  ): Finding {
    const pos = node.getStart();
    const { line, column } = source.getLineAndColumnAtPos(pos);
    return {
      id,
      ruleId,
      ruleKind,
      file: relFile,
      line,
      column,
      snippet: node.getText(),
    };
  }

  private listSourceFiles(repoPath: string): string[] {
    const roots = ['src', 'lib', 'app', 'test', 'tests', '__tests__', '__mocks__']
      .map(d => path.join(repoPath, d))
      .filter(d => fs.existsSync(d) && fs.statSync(d).isDirectory());
    const searchRoots = roots.length > 0 ? roots : [repoPath];

    const files: string[] = [];
    for (const root of searchRoots) {
      this.walk(root, files);
    }
    return [...new Set(files)];
  }

  private walk(dir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        this.walk(path.join(dir, entry.name), out);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      out.push(path.join(dir, entry.name));
    }
  }
}
