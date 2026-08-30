#!/usr/bin/env bun
/**
 * No-hand-written-mirror-types gate.
 *
 * The curated layer — every directory in {@link CURATED_DIRS} plus every file in
 * {@link CURATED_FILES} (today: `src/{errors,flows,hal,validation,auth,signing,react}` and
 * `src/client.ts`) — is allowed exactly one relationship to a response the API sends:
 * import the generated type from `src/generated/`. Nothing in that set may re-declare its
 * own version of a generated response shape — that is precisely the duplication
 * `src/generated/` exists to make unnecessary, and a silent mirror rots the moment the
 * spec changes underneath it. That scope is the WHOLE curated layer this repo ships
 * (`src/index.ts`'s and `src/react/index.ts`'s and `src/signing/index.ts`'s own entry
 * points) — not a subset chosen because those were the directories that happened to pass
 * when this gate was first written. `src/generated/` itself is never scanned as a curated
 * source; it is only ever the comparison target.
 *
 * This is a STRUCTURAL check, not a name check: it parses every top-level
 * `interface`/object-`type` declaration on both sides with the TypeScript compiler API,
 * reduces each to its first-level property-name set, and flags a local shape whose
 * properties overlap a generated response shape's properties too closely to be
 * coincidence. See {@link MIN_PROPERTIES_TO_COMPARE} for the one honest limit on that: a
 * shape with fewer properties than that is never compared, at all, no matter how exact an
 * overlap it has.
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
 *     resemble a response shape's. (Some options bags DO overlap a response shape closely
 *     enough to trip the structural check anyway — see {@link ALLOWLIST} for the named
 *     exceptions and why each one is legitimate rather than a silent mirror.)
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
 *   - Anything in {@link ALLOWLIST}, each entry individually reasoned — not a blanket
 *     exemption for a directory or a file.
 *
 * A gate that has never failed is decoration (see this repo's mutation-check discipline) —
 * this script's own handoff/PR description records the deliberate mirror it was run
 * against and confirmed red before being removed. It was also run once with the scope
 * widened to `src/signing` and `src/react` and no {@link ALLOWLIST} yet — that run is what
 * found `SignableTypedData`, `BuildEip712Params`, `MintPintParams`, and
 * `MintPintAsAgentParams`, which is where {@link ALLOWLIST}'s four entries came from.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const CURATED_DIRS = [
  'src/errors',
  'src/flows',
  'src/hal',
  'src/validation',
  'src/auth',
  'src/signing',
  'src/react',
];
// Individual curated files that live directly under `src/` rather than in
// one of `CURATED_DIRS` — `src/client.ts` (the `createSumvinClient` factory)
// is the only one today.
const CURATED_FILES = ['src/client.ts'];
const GENERATED_TYPES_FILE = 'src/generated/types.gen.ts';

// Below this many properties, name-overlap is too likely to be coincidence
// (e.g. every options bag in this codebase has a 1-2 property overlap with
// SOMETHING) to be worth comparing at all.
//
// Stated honestly, because the limit is easy to leave implied: a curated
// shape with 1 or 2 properties is NEVER compared, full stop, no matter how
// exactly it overlaps a generated response shape. A 2-property mirror of a
// 2-property generated shape (`{ id, status }`, say) passes this gate
// unconditionally, everywhere in the curated layer — this check's coverage
// begins at 3 properties, not 1.
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

/**
 * Named, individually-reasoned exceptions to this gate. Each entry is a
 * shape this script's structural check flags as a mirror, that a human has
 * looked at and judged legitimate — never a directory- or file-level
 * exemption, and never added without the reasoning that justifies it.
 *
 * Every entry here was a confirmed `FAIL` from this script (see this file's
 * module doc) before being added — the allowlist records a reviewed
 * decision, not a way to silence a finding nobody looked at.
 */
const ALLOWLIST: ReadonlyArray<{
  readonly file: string;
  readonly name: string;
  readonly reason: string;
}> = [
  {
    file: 'src/signing/types.ts',
    name: 'SignableTypedData',
    reason:
      'Deliberately not the generated Eip712Payload: the two signing ceremonies populate ' +
      "`message` differently (mintPint's JSON-safe number/string fields vs decideErrand's " +
      'BigInt-coerced fields from `coerceTypedDataIntegers`), so SignableTypedData is ' +
      'intentionally looser than the wire type either ceremony actually sends. See this ' +
      "type's own TSDoc in `src/signing/types.ts`.",
  },
  {
    file: 'src/signing/eip712.ts',
    name: 'BuildEip712Params',
    reason:
      'An INPUT params bag for buildEip712TypedData, not a response the SDK receives — it ' +
      'overlaps Eip712PurchaseIntentMessage because D6 requires these fields to become that ' +
      'exact wire message, byte-for-byte, plus a required `chainId` the generated message ' +
      'type has no field for. Field-shape drift between this bag and the backend-signed ' +
      "message is caught by `src/signing/typehash.test.ts`'s D9 numeric parity gate (a " +
      'field rename/reorder/retype changes the asserted type hash), a stronger, ' +
      'byte-precise check than this structural overlap comparison could give it.',
  },
  {
    file: 'src/signing/mint-pint.ts',
    name: 'MintPintParams',
    reason:
      'Same reasoning as BuildEip712Params (this bag flows straight into it) plus its own ' +
      'non-message fields (client, audience, sourceChatMessageId, parentPintUri, ' +
      'signTypedData, maxAttempts) that Eip712PurchaseIntentMessage has no equivalent for.',
  },
  {
    file: 'src/signing/mint-pint.ts',
    name: 'MintPintAsAgentParams',
    reason:
      'Same reasoning as MintPintParams, minus `nonce`/`chainId`/`signTypedData` — ' +
      'mintPintAsAgent is not a signing ceremony (D6: the server signs), so this bag omits ' +
      'every field only a client-signed request needs.',
  },
];

function isAllowlisted(shape: Shape): boolean {
  return ALLOWLIST.some((entry) => entry.file === shape.file && entry.name === shape.name);
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

  const curatedFiles = [...CURATED_DIRS.flatMap(listTsFiles), ...CURATED_FILES];
  const curatedShapes = curatedFiles
    .flatMap((f) => extractShapes(f))
    .filter((s) => s.properties.size >= MIN_PROPERTIES_TO_COMPARE);

  console.log(
    `Comparing ${curatedShapes.length} curated shape(s) (>= ${MIN_PROPERTIES_TO_COMPARE} properties) ` +
      `across ${curatedFiles.length} file(s) against ${generatedShapes.length} generated response shape(s).`,
  );

  let failures = 0;
  const allowlistHits = new Set<string>();
  for (const local of curatedShapes) {
    let worst: { shape: Shape; score: number } | undefined;
    for (const generated of generatedShapes) {
      const score = overlapScore(local.properties, generated.properties);
      if (!worst || score > worst.score) worst = { shape: generated, score };
    }
    if (worst && worst.score >= OVERLAP_THRESHOLD) {
      if (isAllowlisted(local)) {
        allowlistHits.add(`${local.file}:${local.name}`);
        console.log(
          `  ALLOW ${local.file}: ${local.name} (overlap ${(worst.score * 100).toFixed(0)}% ` +
            `with generated ${worst.shape.name}) — reviewed exception, see ALLOWLIST`,
        );
        continue;
      }
      failures += 1;
      console.log(
        `  FAIL  ${local.file}: ${local.name} { ${[...local.properties].join(', ')} } ` +
          `looks like a hand-written mirror of generated ${worst.shape.name} ` +
          `{ ${[...worst.shape.properties].join(', ')} } (overlap ${(worst.score * 100).toFixed(0)}%). ` +
          `Import the type from src/generated/ instead of re-declaring it.`,
      );
    }
  }

  // An allowlist entry that this run never matched is stale: either the
  // shape was renamed/removed/reshaped (drift the entry no longer
  // describes), or it was never a real finding. Either way it's a lint
  // exemption nobody is checking any more — fail loudly rather than let it
  // silently widen over time.
  for (const entry of ALLOWLIST) {
    const key = `${entry.file}:${entry.name}`;
    if (!allowlistHits.has(key)) {
      failures += 1;
      console.log(
        `  STALE ${key} is in ALLOWLIST but was not flagged this run — remove the entry ` +
          `or confirm it still applies (the shape may have been renamed, removed, or ` +
          `no longer overlaps a generated shape).`,
      );
    }
  }

  if (failures === 0) {
    console.log('  PASS  no unreviewed curated type/interface mirrors a generated response shape');
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} issue(s) found.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
