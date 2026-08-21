import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared by scripts/pull-spec.ts and scripts/check-spec-fresh.ts. Both sides of a
// freshness comparison MUST run through the same fetch/validate/normalise path --
// a raw fetch compared against a normalised vendored file fails every time (the
// spec's 2,210 `\u` escapes decode to real UTF-8 under jq). See spec/SOURCE.md.

const HERE = dirname(fileURLToPath(import.meta.url));

export const GITHUB_REPO = 'sibylline-advisory/sumvin-api';
export const SPEC_PATH_IN_REPO = 'docs/api-reference/openapi.json';
export const SPEC_TARGET_PATH = resolve(HERE, '../../spec/openapi.json');
export const PIN_PATH = resolve(HERE, '../../spec/PIN');

const PIN_PATTERN = /^[0-9a-f]{40}$/;

// jq's default execFileSync stdout buffer (1 MB) truncates well before our
// ~1.3 MB spec.
const EXEC_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Reads and validates spec/PIN -- the single source of truth every script reads. */
export function readPin(pinPath: string = PIN_PATH): string {
  const raw = readFileSync(pinPath, 'utf8').trim();
  if (!PIN_PATTERN.test(raw)) {
    throw new Error(`${pinPath} does not contain a 40-char hex SHA (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a human-readable reason `body` is not a usable OpenAPI document, or
 * null when it is. GitHub's Contents API answers HTTP 200 with
 * {"size": N, "encoding": "none", "content": ""} once a blob crosses the 1 MB
 * inline-content boundary (our spec is 1,333,669 bytes) -- HTTP status alone
 * is not sufficient evidence that the payload is real.
 */
export function describeSpecDefect(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return `body is not JSON (${(error as Error).message})`;
  }
  if (!isPlainObject(parsed)) return 'body is not a JSON object';
  if (typeof parsed.openapi !== 'string') return 'no "openapi" version string';
  if (!isPlainObject(parsed.paths)) return 'no "paths" object';
  const components = parsed.components;
  if (!isPlainObject(components) || !isPlainObject(components.schemas)) {
    return 'no "components.schemas" object';
  }
  return null;
}

/**
 * Fetches the spec blob at `sha` via the GitHub Contents API.
 *
 * The `Accept: application/vnd.github.raw` header is MANDATORY, not a
 * preference. The default (JSON-wrapped, base64) response form has a 1 MB
 * inline-content limit; our spec is 1,333,669 bytes, past that limit, so the
 * default form answers `{"size":1333669,"encoding":"none","content":""}` at
 * HTTP 200 -- an empty spec at a success status. The raw header bypasses the
 * base64 envelope entirely and returns the blob bytes directly.
 */
export function fetchSpecAtSha(sha: string): string {
  const ref = `repos/${GITHUB_REPO}/contents/${SPEC_PATH_IN_REPO}?ref=${sha}`;
  let body: string;
  try {
    body = execFileSync('gh', ['api', ref, '-H', 'Accept: application/vnd.github.raw'], {
      encoding: 'utf8',
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new Error('gh is not installed, install it and re-run');
    }
    throw new Error(`gh api fetch failed (${(error as Error).message})`);
  }
  const defect = describeSpecDefect(body);
  if (defect !== null) {
    throw new Error(`fetched payload at ${sha} is not a usable OpenAPI document: ${defect}`);
  }
  return body;
}

/** Normalises a JSON payload with `jq .` so re-pins produce minimal diffs. */
export function normalizeWithJq(body: string): Buffer {
  try {
    return execFileSync('jq', ['.'], { input: body, maxBuffer: EXEC_MAX_BUFFER_BYTES });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new Error('jq is not installed, install it and re-run');
    }
    throw new Error(`jq could not normalise the payload (${(error as Error).message})`);
  }
}

/**
 * Writes `data` to `targetPath` via a temp-file-beside-target + rename, so a
 * failure partway through a write never truncates the target. The temp name
 * matches the `.spec.tmp.*` pattern already carved out in .gitignore.
 */
export function writeAtomic(targetPath: string, data: Buffer): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = resolve(dirname(targetPath), `.spec.tmp.${process.pid}`);
  try {
    writeFileSync(tempPath, data);
    renameSync(tempPath, targetPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}
