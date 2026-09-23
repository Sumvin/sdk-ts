#!/usr/bin/env bun
/**
 * Generation acceptance gate.
 *
 * `openapi-ts` exits 0 on config it does not understand — an unknown plugin
 * key is silently skipped. "Generation succeeded" is therefore not evidence
 * that any particular option took effect. Every assertion below is derived
 * from `spec/openapi.json` at run time (nothing about operation, schema, or
 * union counts is hard-coded) and checks something the generator could get
 * wrong or silently drop without the build going red.
 *
 * `@hey-api/shared`'s own `toCase()` is used (not a reimplementation) to
 * predict the exact identifier names `@hey-api/openapi-ts@0.99.0` emits for
 * a given schema/operation name, so assertions 3 and 5 can locate specific
 * generated symbols without hard-coding any of them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toCase } from '@hey-api/shared';
import ts from 'typescript';

type JsonObject = Record<string, unknown>;

const SPEC_PATH = 'spec/openapi.json';
const GENERATED_DIR = 'src/generated';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf-8')) as JsonObject;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let failures = 0;

function section(title: string): void {
  console.log(`\n${title}`);
}

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Spec-derived operation enumeration (shared by assertions 1, 7, 8)
// ---------------------------------------------------------------------------

interface SpecOperation {
  path: string;
  method: (typeof HTTP_METHODS)[number];
  operationId: string;
  operation: JsonObject;
}

function specOperations(): SpecOperation[] {
  const paths = (spec.paths ?? {}) as Record<string, JsonObject>;
  const ops: SpecOperation[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as JsonObject | undefined;
      if (!operation) continue;
      const operationId = operation.operationId as string | undefined;
      if (!operationId) continue;
      ops.push({ path, method, operationId, operation });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Discriminated-union site discovery (shared by assertions 2, 3, 5)
//
// Walks the WHOLE spec — both `components.schemas` and `paths` — because two
// of the eleven discriminated unions on this spec are inlined directly in a
// request body and never promoted to a named component (P13's wallets/visa
// checkout sites).
// ---------------------------------------------------------------------------

interface DiscriminatedSite {
  id: string;
  /** The top-level `components.schemas` key that owns this site, or null if
   * the site is inlined directly in a path operation's request body. */
  containerSchema: string | null;
  /** Set when `containerSchema` is null. */
  operationId: string | null;
  discriminatorProp: string;
  /** Schema names referenced via `$ref` inside the `oneOf`. */
  branchSchemas: string[];
  /** JSON path segments from the container/operation root down to (but not
   * including) the oneOf node itself — used to build a reaching payload. */
  fieldPath: string[];
}

type RawSite = Pick<DiscriminatedSite, 'discriminatorProp' | 'branchSchemas' | 'fieldPath'>;

function walkForDiscriminated(node: unknown, fieldPath: string[], out: RawSite[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      walkForDiscriminated(v, [...fieldPath, `[${i}]`], out);
    });
    return;
  }
  if (node && typeof node === 'object') {
    const n = node as JsonObject;
    const discriminator = n.discriminator as JsonObject | undefined;
    if (Array.isArray(n.oneOf) && discriminator && typeof discriminator.propertyName === 'string') {
      const branchSchemas = (n.oneOf as JsonObject[])
        .map((m) => (typeof m.$ref === 'string' ? m.$ref.split('/').pop() : null))
        .filter((x): x is string => x !== null);
      out.push({ discriminatorProp: discriminator.propertyName, branchSchemas, fieldPath });
    }
    for (const [k, v] of Object.entries(n)) {
      walkForDiscriminated(v, [...fieldPath, k], out);
    }
  }
}

function findDiscriminatedSites(): DiscriminatedSite[] {
  const sites: DiscriminatedSite[] = [];

  const schemas = ((spec.components as JsonObject | undefined)?.schemas ?? {}) as Record<
    string,
    JsonObject
  >;
  for (const [schemaName, schema] of Object.entries(schemas)) {
    const found: RawSite[] = [];
    walkForDiscriminated(schema, [], found);
    found.forEach((f, i) => {
      sites.push({
        id: `schema:${schemaName}${found.length > 1 ? `#${i}` : ''}`,
        containerSchema: schemaName,
        operationId: null,
        ...f,
      });
    });
  }

  for (const op of specOperations()) {
    const found: RawSite[] = [];
    walkForDiscriminated(op.operation, [], found);
    found.forEach((f, i) => {
      sites.push({
        id: `op:${op.operationId}${found.length > 1 ? `#${i}` : ''}`,
        containerSchema: null,
        operationId: op.operationId,
        ...f,
      });
    });
  }

  return sites;
}

/** `@hey-api/sdk`/`zod`'s naming for a schema-rooted site: `z` + PascalCase. */
function exportNameForSite(site: DiscriminatedSite): string {
  if (site.containerSchema) return `z${toCase(site.containerSchema, 'PascalCase')}`;
  // A pathless (request-body-only) site: the zod plugin's request-body
  // naming default is `{{name}}Body`, name = the operation in PascalCase.
  return `z${toCase(site.operationId as string, 'PascalCase')}Body`;
}

/**
 * Union-find over "shares a branch schema name" edges, seeded by sites that
 * are directly self-referential (their own container appears among their
 * own branches). Empirically validated against this spec: hey-api's zod
 * plugin degrades a discriminated union to `z.union` not only when the site
 * is itself cyclic, but whenever ANY schema in the union's branch set is
 * shared with a site that is cyclic — because that shared branch
 * requires a forward/lazy reference, and Zod's discriminator-map builder
 * cannot accept a lazy branch. Grouping by shared-branch-membership gives
 * the same partition as hey-api's internal circularity tracking on this
 * spec (verified 11/11 against the emitted `zod.gen.ts`); it is not a
 * byte-for-byte reimplementation of hey-api's algorithm.
 */
function classifyRecursive(sites: DiscriminatedSite[]): boolean[] {
  const parent = sites.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i: number, j: number): void {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      if (sites[i].branchSchemas.some((b) => sites[j].branchSchemas.includes(b))) union(i, j);
    }
  }

  const isDirectSelf = (s: DiscriminatedSite) =>
    s.containerSchema !== null && s.branchSchemas.includes(s.containerSchema);
  const recursiveRoots = new Set<number>();
  sites.forEach((s, i) => {
    if (isDirectSelf(s)) recursiveRoots.add(find(i));
  });

  return sites.map((_, i) => recursiveRoots.has(find(i)));
}

/** Slices the source text for one `export const <name> = ...` block, up to
 * (but not including) the next top-level `export const`. */
function extractConstBody(source: string, constName: string): string | null {
  const marker = `export const ${constName} = `;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const next = source.indexOf('\nexport const ', start + marker.length);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

// ---------------------------------------------------------------------------
// 1. SDK exports >= one per spec operation, zero name collisions
// ---------------------------------------------------------------------------

async function assertSdkExports(): Promise<void> {
  section('1. SDK exports >= one per spec operation (174), zero name collisions');

  const ops = specOperations();
  const sdkModule = (await import('../src/generated/sdk.gen')) as Record<string, unknown>;
  const exportNames = Object.keys(sdkModule);

  check(
    'sdk.gen.ts exports at least one binding per operation',
    exportNames.length >= ops.length,
    `${exportNames.length} runtime exports for ${ops.length} spec operations`,
  );

  // A collision would be two distinct operationIds collapsing to the same
  // camelCase identifier (the SDK's `methodName.casing` transform).
  const byCamelName = new Map<string, string[]>();
  for (const op of ops) {
    const name = toCase(op.operationId, 'camelCase');
    const ids = byCamelName.get(name) ?? [];
    ids.push(op.operationId);
    byCamelName.set(name, ids);
  }
  const collisions = [...byCamelName.entries()].filter(([, ids]) => new Set(ids).size > 1);
  check(
    'zero operationId -> camelCase collisions',
    collisions.length === 0,
    collisions.length
      ? collisions.map(([n, ids]) => `${n} <- ${ids.join(', ')}`).join('; ')
      : undefined,
  );

  const missing = [...byCamelName.keys()].filter((name) => !(name in sdkModule));
  check(
    'every derived camelCase name is actually exported',
    missing.length === 0,
    missing.length ? missing.slice(0, 10).join(', ') : undefined,
  );
}

// ---------------------------------------------------------------------------
// 2. Recomputed patch manifest is [] — the no-hand-patch invariant, re-derived here
// ---------------------------------------------------------------------------

function computePatchManifest(): string[] {
  const branches = new Map<string, string>();
  for (const site of findDiscriminatedSites()) {
    for (const branchName of site.branchSchemas) branches.set(branchName, site.discriminatorProp);
  }

  const schemas = ((spec.components as JsonObject | undefined)?.schemas ?? {}) as Record<
    string,
    JsonObject
  >;
  const patched: string[] = [];
  for (const [schemaName, property] of branches) {
    const schema = schemas[schemaName];
    if (!schema) continue;
    const properties = (schema.properties ?? {}) as JsonObject;
    const target = properties[property] as JsonObject | undefined;
    if (!target) continue;

    const required = (schema.required as string[] | undefined) ?? [];
    const hasDefault = Object.hasOwn(target, 'default');
    const isRequired = required.includes(property);
    if (hasDefault || !isRequired) patched.push(`${schemaName}.${property}`);
  }
  return patched.sort();
}

function assertPatchManifest(): void {
  section(
    '2. Recomputed patch manifest is [] (no-hand-patch invariant, re-derived from the spec here)',
  );
  const manifest = computePatchManifest();
  check(
    'no discriminator branch needs a default/required patch',
    manifest.length === 0,
    manifest.length ? manifest.join(', ') : undefined,
  );
}

// ---------------------------------------------------------------------------
// 3. z.discriminatedUnion count == spec sites minus the recursive family
// ---------------------------------------------------------------------------

function assertDiscriminatedUnions(zodSource: string): void {
  section('3. z.discriminatedUnion( count == discriminated-union sites minus the recursive family');

  const sites = findDiscriminatedSites();
  const recursiveFlags = classifyRecursive(sites);
  const recursiveSites = sites.filter((_, i) => recursiveFlags[i]);
  const nonRecursiveSites = sites.filter((_, i) => !recursiveFlags[i]);
  const directSelfSites = sites.filter(
    (s) => s.containerSchema !== null && s.branchSchemas.includes(s.containerSchema),
  );

  console.log(
    `  spec: ${sites.length} discriminated-union sites — ${recursiveSites.length} recursive-family, ` +
      `${directSelfSites.length} directly self-referential, ${nonRecursiveSites.length} plain`,
  );

  const actualDiscriminatedUnionCount = (zodSource.match(/z\.discriminatedUnion\(/g) ?? []).length;
  check(
    'emitted z.discriminatedUnion( count matches the plain (non-recursive) sites',
    actualDiscriminatedUnionCount === nonRecursiveSites.length,
    `expected ${nonRecursiveSites.length} (${nonRecursiveSites.map((s) => s.id).join(', ')}); emitted ${actualDiscriminatedUnionCount}`,
  );

  const actualLazyCount = (zodSource.match(/z\.lazy\(/g) ?? []).length;
  check(
    'emitted z.lazy( count matches the directly self-referential sites (the true cycles)',
    actualLazyCount === directSelfSites.length,
    `expected ${directSelfSites.length} (${directSelfSites.map((s) => s.containerSchema).join(', ')}); emitted ${actualLazyCount}`,
  );

  // Per-site complement: every plain site's own export is a discriminated
  // union; every recursive site's own export falls back to z.union and never
  // itself claims z.discriminatedUnion; every directly self-referential site
  // additionally breaks its own cycle with z.lazy.
  for (const site of nonRecursiveSites) {
    const name = exportNameForSite(site);
    const body = extractConstBody(zodSource, name);
    check(
      `${site.id} (${name}) itself emits z.discriminatedUnion`,
      !!body && body.includes('z.discriminatedUnion('),
      body ? undefined : `${name} not found as a top-level export in zod.gen.ts`,
    );
  }
  for (const site of recursiveSites) {
    const name = exportNameForSite(site);
    const body = extractConstBody(zodSource, name);
    const isDirectSelf =
      site.containerSchema !== null && site.branchSchemas.includes(site.containerSchema);
    check(
      `${site.id} (${name}) falls back to z.union, not z.discriminatedUnion`,
      !!body && body.includes('z.union(') && !body.includes('z.discriminatedUnion('),
      body ? undefined : `${name} not found as a top-level export in zod.gen.ts`,
    );
    if (isDirectSelf) {
      check(
        `${site.id} (${name}) breaks its own cycle with z.lazy`,
        !!body && body.includes('z.lazy('),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. `any` in type position — TypeScript AST walk, not a regex
// ---------------------------------------------------------------------------

/**
 * Measured directly against this spec/config on first generation
 * (2026-08-21): 12 `AnyKeyword` nodes total across `src/generated/**`, of
 * which 2 are the allowlisted `z.lazy((): any => …)` return positions for
 * the two directly self-referential `ConditionGroup-Input`/`-Output`
 * schemas, leaving 10 non-allowlisted (`as any` casts and untyped `any`
 * locals in hey-api's own emitted client/TanStack runtime — none in
 * generated schema/SDK code). The figure is deliberately measured against
 * this spec and this config rather than carried over from another client:
 * a different spec or a different `@tanstack/react-query` config yields a
 * different baseline, so an inherited number would be wrong here.
 */
const ANY_KEYWORD_BASELINE = 10;

function isZodLazyReturnAny(node: ts.Node): boolean {
  if (node.kind !== ts.SyntaxKind.AnyKeyword) return false;
  const parent = node.parent;
  if (!parent || !ts.isArrowFunction(parent) || parent.type !== node) return false;
  const call = parent.parent;
  if (!call || !ts.isCallExpression(call)) return false;
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'lazy';
}

function listGeneratedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listGeneratedFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function assertAnyInTypePosition(): void {
  section('4. `any` in type position (TS AST walk), allowlisting z.lazy return positions');

  let total = 0;
  let allowlisted = 0;
  const nonAllowlisted: string[] = [];

  for (const file of listGeneratedFiles(GENERATED_DIR)) {
    const text = readFileSync(file, 'utf-8');
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );

    function visit(node: ts.Node): void {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        total++;
        if (isZodLazyReturnAny(node)) {
          allowlisted++;
        } else {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          nonAllowlisted.push(`${file}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  const sites = findDiscriminatedSites();
  const directSelfCount = sites.filter(
    (s) => s.containerSchema !== null && s.branchSchemas.includes(s.containerSchema),
  ).length;

  check(
    'allowlisted z.lazy((): any => …) count matches directly self-referential sites',
    allowlisted === directSelfCount,
    `expected ${directSelfCount}, found ${allowlisted}`,
  );
  check(
    `non-allowlisted \`any\` count matches the measured baseline (${ANY_KEYWORD_BASELINE})`,
    total - allowlisted === ANY_KEYWORD_BASELINE,
    `found ${total - allowlisted}: ${nonAllowlisted.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// 5. Every generated union is total: a reaching payload never throws
// ---------------------------------------------------------------------------

function discriminatorValueForBranch(
  branchSchemaName: string,
  discriminatorProp: string,
): string | null {
  const schemas = ((spec.components as JsonObject | undefined)?.schemas ?? {}) as Record<
    string,
    JsonObject
  >;
  const schema = schemas[branchSchemaName];
  const prop = (schema?.properties as JsonObject | undefined)?.[discriminatorProp] as
    | JsonObject
    | undefined;
  if (!prop) return null;
  if (typeof prop.const === 'string') return prop.const;
  if (Array.isArray(prop.enum) && prop.enum.length === 1 && typeof prop.enum[0] === 'string') {
    return prop.enum[0] as string;
  }
  return null;
}

function buildReachingPayload(site: DiscriminatedSite, branchValue: string): unknown {
  const propsCount = site.fieldPath.filter((s) => s === 'properties').length;
  if (propsCount > 1) {
    throw new Error(
      `${site.id}: nested more than one \`properties\` level deep (${site.fieldPath.join('.')}) — ` +
        'the reaching-payload builder does not support this shape',
    );
  }

  const leaf: JsonObject = { [site.discriminatorProp]: branchValue };
  if (propsCount === 0) return leaf; // the site's own schema IS the union

  const propsIdx = site.fieldPath.indexOf('properties');
  const propName = site.fieldPath[propsIdx + 1];
  const isArray = site.fieldPath.slice(propsIdx).includes('items');
  return { [propName]: isArray ? [leaf] : leaf };
}

async function assertUnionTotality(): Promise<void> {
  section('5. Every generated union is total: a reaching payload never throws safeParse');

  const zodModule = (await import('../src/generated/zod.gen')) as Record<string, unknown>;
  const sites = findDiscriminatedSites();
  let checked = 0;

  for (const site of sites) {
    const exportName = exportNameForSite(site);
    const schema = zodModule[exportName] as { safeParse: (v: unknown) => unknown } | undefined;
    if (!schema || typeof schema.safeParse !== 'function') {
      check(
        `${site.id}: ${exportName} exported with a safeParse method`,
        false,
        'not found in zod.gen.ts',
      );
      continue;
    }

    for (const branchName of site.branchSchemas) {
      const value = discriminatorValueForBranch(branchName, site.discriminatorProp);
      if (value === null) {
        check(
          `${site.id} branch ${branchName}: discriminator literal resolvable from the spec`,
          false,
        );
        continue;
      }

      let threw: unknown = null;
      try {
        schema.safeParse(buildReachingPayload(site, value));
      } catch (error) {
        threw = error;
      }
      checked++;
      check(
        `${site.id} branch ${branchName} (${site.discriminatorProp}=${value}): safeParse does not throw`,
        threw === null,
        threw ? String((threw as Error)?.message ?? threw) : undefined,
      );
    }
  }

  check(
    'at least one reaching payload was actually parsed',
    checked > 0,
    `${checked} safeParse calls made`,
  );
}

// ---------------------------------------------------------------------------
// 6. Zero z.literal(x).optional().default(x) — the cheap textual complement
// ---------------------------------------------------------------------------

function assertNoDuplicateDiscriminatorDefault(zodSource: string): void {
  section('6. Zero z.literal(x).optional().default(x) on any generated schema');
  const pattern = /z\.literal\((['"])((?:(?!\1).)*)\1\)\.optional\(\)\.default\(\1\2\1\)/g;
  const matches = [...zodSource.matchAll(pattern)].map((m) => m[0]);
  check(
    'no literal-optional-default duplication pattern',
    matches.length === 0,
    matches.join('; ') || undefined,
  );
}

// ---------------------------------------------------------------------------
// 7. Exactly 2 non-JSON response operations, exactly 4 multipart operations
// ---------------------------------------------------------------------------

function assertContentTypeCounts(): void {
  section(
    '7. Exactly 2 non-JSON response operations, exactly 4 multipart/form-data request operations',
  );

  const nonJson = new Set<string>();
  const multipart = new Set<string>();
  const sse = new Set<string>();

  for (const op of specOperations()) {
    const responses = (op.operation.responses ?? {}) as JsonObject;
    for (const response of Object.values(responses)) {
      const content = ((response as JsonObject)?.content ?? {}) as JsonObject;
      const mediaTypes = Object.keys(content);
      if (mediaTypes.some((mt) => mt !== 'application/json')) nonJson.add(op.operationId);
      if (mediaTypes.includes('text/event-stream')) sse.add(op.operationId);
    }
    const requestBody = op.operation.requestBody as JsonObject | undefined;
    const reqContent = (requestBody?.content ?? {}) as JsonObject;
    if ('multipart/form-data' in reqContent) multipart.add(op.operationId);
  }

  check(
    'exactly 2 operations return a non-JSON content type',
    nonJson.size === 2,
    [...nonJson].join(', '),
  );
  check(
    'exactly 4 operations accept multipart/form-data',
    multipart.size === 4,
    [...multipart].join(', '),
  );
  check(
    'zero operations use text/event-stream (SSE is a non-issue for this phase)',
    sse.size === 0,
    [...sse].join(', '),
  );
}

// ---------------------------------------------------------------------------
// 8. `response` is present on the SDK's returned object
// ---------------------------------------------------------------------------

/** Picks a GET operation with no required parameters and no request body,
 * so it can be called with `{}` against a mocked fetch. Derived from the
 * spec at run time — not a hard-coded operation name. */
function pickTrivialGetOperation(): SpecOperation {
  const candidate = specOperations().find((op) => {
    if (op.method !== 'get') return false;
    if (op.operation.requestBody) return false;
    const params = (op.operation.parameters ?? []) as JsonObject[];
    return !params.some((p) => p.required === true);
  });
  if (!candidate) throw new Error('no parameterless GET operation found in the spec to probe with');
  return candidate;
}

async function assertResponseFieldPresent(): Promise<void> {
  section("8. `response` is present on the SDK's returned object (15/174 ops have >1 2xx)");

  const op = pickTrivialGetOperation();
  const exportName = toCase(op.operationId, 'camelCase');

  const sdkModule = (await import('../src/generated/sdk.gen')) as Record<string, unknown>;
  const fn = sdkModule[exportName] as
    | ((options: unknown) => Promise<Record<string, unknown>>)
    | undefined;
  if (typeof fn !== 'function') {
    check(
      `${exportName} exported from sdk.gen.ts`,
      false,
      `probing with operation ${op.operationId}`,
    );
    return;
  }

  const { client } = (await import('../src/generated/client.gen')) as {
    client: { setConfig: (c: Record<string, unknown>) => void };
  };

  client.setConfig({
    baseUrl: 'https://sumvin-sdk-assert-generated.invalid',
    fetch: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  const success = await fn({});
  check(
    `${op.operationId}() success path: 'response' is a real Response`,
    'response' in success && success.response instanceof Response,
    `keys: ${Object.keys(success).join(', ')}`,
  );

  client.setConfig({
    baseUrl: 'https://sumvin-sdk-assert-generated.invalid',
    fetch: async () =>
      new Response(JSON.stringify({ detail: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  const errored = await fn({});
  check(
    `${op.operationId}() error path: 'response' carries the real status (404)`,
    'response' in errored &&
      errored.response instanceof Response &&
      (errored.response as Response).status === 404,
    `keys: ${Object.keys(errored).join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const zodSource = readFileSync(`${GENERATED_DIR}/zod.gen.ts`, 'utf-8');

  await assertSdkExports();
  assertPatchManifest();
  assertDiscriminatedUnions(zodSource);
  assertAnyInTypePosition();
  await assertUnionTotality();
  assertNoDuplicateDiscriminatorDefault(zodSource);
  assertContentTypeCounts();
  await assertResponseFieldPresent();

  console.log(
    `\n${failures === 0 ? 'All assertions passed.' : `${failures} assertion(s) failed.`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
