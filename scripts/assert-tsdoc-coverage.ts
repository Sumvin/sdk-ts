#!/usr/bin/env bun
/**
 * TSDoc-coverage gate over the curated layer's public surface.
 *
 * Walks the three package entry points (`.`, `./react`, `./signing`) with the TypeScript
 * compiler API, resolves every exported symbol to its real declaration (following
 * `export { X } from './y'` aliases all the way through), and requires a non-empty JSDoc
 * comment on every one that this repo actually AUTHORS.
 *
 * Scoped to authored code, deliberately: a symbol whose declaration lives under
 * `src/generated/` is skipped. That tree is regenerated from the vendored spec
 * (`bun run generate`, gated separately by `assert:generated` and `spec:check`) — this repo
 * cannot add a doc comment to it without hand-editing generated output, which
 * `README.md`'s "the generated tree is never hand-edited" rule forbids. Measured directly
 * against this build: 867 of 1258 generated `types.gen.ts` exports, 367 of 932 generated
 * `zod.gen.ts` schemas, and 105 of 299 generated TanStack artifacts carry no doc comment at
 * all (the spec simply has no `description` for them) — enforcing coverage there would be
 * enforcing something on a file this repo cannot fix. This gate's job is the ~120-symbol
 * layer ENG-3424 actually adds on top: `createSumvinClient` and every export under
 * `src/{errors,auth,validation,hal,flows}` plus `src/react/invalidation-groups.ts` and
 * `src/signing/*` (the parts of `.`/`./react`/`./signing` this repo authors and can fix).
 */
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const TSCONFIG_PATH = resolve(ROOT, 'tsconfig.json');
const GENERATED_ROOT = resolve(ROOT, 'src/generated');

const ENTRY_POINTS = ['src/index.ts', 'src/react/index.ts', 'src/signing/index.ts'].map((p) =>
  resolve(ROOT, p),
);

function loadProgram(): ts.Program {
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(TSCONFIG_PATH));
  return ts.createProgram({ rootNames: ENTRY_POINTS, options: parsed.options });
}

/** Follows `export { X } from './y'` alias chains to the symbol that actually declares X. */
function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  let resolved = symbol;
  while (resolved.flags & ts.SymbolFlags.Alias) {
    resolved = checker.getAliasedSymbol(resolved);
  }
  return resolved;
}

function isGenerated(symbol: ts.Symbol): boolean {
  return (symbol.getDeclarations() ?? []).every((d) =>
    resolve(d.getSourceFile().fileName).startsWith(GENERATED_ROOT),
  );
}

function hasDocComment(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const summary = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (summary.length > 0) return true;
  // A symbol documented ONLY with tags (`@deprecated`, `@see`, …) and no summary text —
  // legitimate, if rare; `getJsDocTags` catches what `getDocumentationComment` doesn't.
  return symbol.getJsDocTags(checker).length > 0;
}

function main(): void {
  const program = loadProgram();
  const checker = program.getTypeChecker();

  let checked = 0;
  let failures = 0;

  for (const entryPath of ENTRY_POINTS) {
    const sourceFile = program.getSourceFile(entryPath);
    if (!sourceFile) {
      console.log(
        `  FAIL  ${entryPath}: not found by the program (check ENTRY_POINTS / tsconfig include)`,
      );
      failures += 1;
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      console.log(`  FAIL  ${entryPath}: TypeScript did not resolve it as a module`);
      failures += 1;
      continue;
    }

    const relative = entryPath.slice(ROOT.length + 1);
    console.log(`\n${relative}`);

    const exportsOfModule = checker.getExportsOfModule(moduleSymbol);
    const seen = new Set<string>();
    for (const exported of exportsOfModule) {
      const resolved = resolveAlias(exported, checker);
      if (isGenerated(resolved)) continue; // out of scope — see file header

      const key = `${resolved.getName()}@${(resolved.getDeclarations() ?? [])
        .map((d) => d.getSourceFile().fileName)
        .join(',')}`;
      if (seen.has(key)) continue; // same symbol re-exported under >1 name from this barrel
      seen.add(key);

      checked += 1;
      if (hasDocComment(resolved, checker)) {
        continue;
      }
      failures += 1;
      const decl = (resolved.getDeclarations() ?? [])[0];
      const loc = decl ? `${decl.getSourceFile().fileName.slice(ROOT.length + 1)}` : '?';
      console.log(`  FAIL  ${exported.getName()} (${loc}) has no TSDoc comment`);
    }
  }

  console.log(
    `\nChecked ${checked} authored export(s) across ${ENTRY_POINTS.length} entry point(s).`,
  );
  console.log(failures === 0 ? 'All checks passed.' : `${failures} undocumented export(s) found.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
