#!/usr/bin/env bun
/**
 * No-hand-written-mirror-types gate.
 *
 * The curated layer (`src/{errors,flows,hal,validation,auth}`) is allowed exactly one
 * relationship to a response the API sends: import the generated type from
 * `src/generated/`. Nothing in those directories may re-declare its own version of a
 * generated response shape — that is precisely the duplication `src/generated/` exists to
 * make unnecessary, and a silent mirror rots the moment the spec changes underneath it.
 *
 * This is a STRUCTURAL check, not a name check: it parses every top-level
 * `interface`/object-`type` declaration on both sides with the TypeScript compiler API,
 * reduces each to its first-level property-name set, and flags a local shape whose
 * properties overlap a generated response shape's properties too closely to be
 * coincidence.
 *
 * What this catches: a hand-typed re-declaration of (all or most of) a generated response
 * body — the failure mode that actually happened in a sibling repo (an app or CLI
 * hand-rolling `{ id: string; status: string; approved_at: number | null; ... }` instead of
 * importing `IPADetailResponse`).
 *
 * What this deliberately does NOT catch (see D1/D6/D7's own design, and the plan's own
 * "be pragmatic" instruction):
 *   - Options bags (`{ client, path, query }`, `{ signal, now, sleep }`) — these describe
 *     what a curated function ACCEPTS, not what the API returns, and their field sets don't
 *     resemble a response shape's.
 *   - Discriminated outcome unions (`KycPollOutcome`, `SafeCreationPollOutcome`, …) — a
 *     union of string-literal-tagged variants, not an object shape to compare.
 *   - Progression/derived views (`KycProgress`, `OnboardingProgress`, …) — these
 *     deliberately RENAME and REDUCE generated fields (e.g. `inFlight`, `recognizedStatus`)
 *     into a smaller, differently-shaped view; low overlap by construction.
 *   - Error-shape types (`ApiErrorInit`, `ContractDriftEvent`) — these describe a FAILURE
 *     this SDK itself produces, which the generated client has no shape for at all.
 *   - A local type that only re-exports or wraps a generated type by reference (e.g.
 *     `type X = { data: SomeGeneratedType }`) — this walk only compares SIBLING property
 *     NAMES, so a single wrapped reference never accumulates enough overlap to trip it.
 *
 * A gate that has never failed is decoration (see this repo's mutation-check discipline) —
 * this script's own handoff/PR description records the deliberate mirror it was run
 * against and confirmed red before being removed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const CURATED_DIRS = ['src/errors', 'src/flows', 'src/hal', 'src/validation', 'src/auth'];
const GENERATED_TYPES_FILE = 'src/generated/types.gen.ts';

// Below this many properties, name-overlap is too likely to be coincidence
// (e.g. every options bag in this codebase has a 1-2 property overlap with
// SOMETHING) to be worth comparing at all.
const MIN_PROPERTIES_TO_COMPARE = 3;
// A local shape whose properties overlap a generated shape's by at least this
// fraction of the SMALLER shape's own property count is flagged. Using the
// smaller side (not the union/Jaccard) is deliberate: a local shape that
// reproduces every field of a small generated shape is exactly as suspicious
// whether or not it also adds a few extra fields of its own (an options bag
// wrapping a response, say) — penalizing it for the extra fields would make
// the gate easier to sneak a mirror past by adding one unrelated field.
const OVERLAP_THRESHOLD = 0.75;

interface Shape {
  file: string;
  name: string;
  properties: ReadonlySet<string>;
}

/** Every top-level `interface X { ... }` and `type X = { ... }` object shape in a file. */
function extractShapes(filePath: string): Shape[] {
  const text = readFileSync(filePath, 'utf-8');
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const shapes: Shape[] = [];

  function propertiesOf(members: ts.NodeArray<ts.TypeElement>): Set<string> | null {
    const names = new Set<string>();
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.name) return null; // index signature, method, etc. — not a plain data shape
      if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
        names.add(member.name.text);
      } else {
        return null; // computed property name — not a plain data shape
      }
    }
    return names;
  }

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node)) {
      const properties = propertiesOf(node.members);
      if (properties) shapes.push({ file: filePath, name: node.name.text, properties });
    } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      // A plain object-literal type alias (`type X = { ... }`). A discriminated
      // union alias (`type X = A | B`) is a `UnionTypeNode`, not a
      // `TypeLiteralNode`, so it already falls outside this branch — unions
      // are outcome shapes, not response shapes, and are excluded on purpose.
      const properties = propertiesOf(node.type.members);
      if (properties) shapes.push({ file: filePath, name: node.name.text, properties });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return shapes;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function overlapScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const name of a) {
    if (b.has(name)) shared += 1;
  }
  const smaller = Math.min(a.size, b.size);
  return smaller === 0 ? 0 : shared / smaller;
}

function main(): void {
  const generatedShapes = extractShapes(GENERATED_TYPES_FILE).filter(
    (s) => s.properties.size >= MIN_PROPERTIES_TO_COMPARE,
  );

  const curatedFiles = CURATED_DIRS.flatMap(listTsFiles);
  const curatedShapes = curatedFiles
    .flatMap((f) => extractShapes(f))
    .filter((s) => s.properties.size >= MIN_PROPERTIES_TO_COMPARE);

  console.log(
    `Comparing ${curatedShapes.length} curated shape(s) (>= ${MIN_PROPERTIES_TO_COMPARE} properties) ` +
      `across ${curatedFiles.length} file(s) against ${generatedShapes.length} generated response shape(s).`,
  );

  let failures = 0;
  for (const local of curatedShapes) {
    let worst: { shape: Shape; score: number } | undefined;
    for (const generated of generatedShapes) {
      const score = overlapScore(local.properties, generated.properties);
      if (!worst || score > worst.score) worst = { shape: generated, score };
    }
    if (worst && worst.score >= OVERLAP_THRESHOLD) {
      failures += 1;
      console.log(
        `  FAIL  ${local.file}: ${local.name} { ${[...local.properties].join(', ')} } ` +
          `looks like a hand-written mirror of generated ${worst.shape.name} ` +
          `{ ${[...worst.shape.properties].join(', ')} } (overlap ${(worst.score * 100).toFixed(0)}%). ` +
          `Import the type from src/generated/ instead of re-declaring it.`,
      );
    }
  }

  if (failures === 0) {
    console.log('  PASS  no curated type/interface mirrors a generated response shape');
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} mirrored type(s) found.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
