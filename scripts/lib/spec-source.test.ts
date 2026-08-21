import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeSpecDefect, normalizeWithJq, readPin, writeAtomic } from './spec-source';

describe('describeSpecDefect', () => {
  // When: a fetched payload is a well-formed OpenAPI document.
  // Then: this test goes red if describeSpecDefect rejects a valid document.
  it('accepts a minimal well-formed OpenAPI document', () => {
    const body = JSON.stringify({ openapi: '3.1.0', paths: {}, components: { schemas: {} } });
    expect(describeSpecDefect(body)).toBeNull();
  });

  // When: GitHub's Contents API answers 200 with the empty-content stub it
  // returns once a blob crosses the 1 MB inline-content boundary (our spec
  // is 1,333,669 bytes -- past it).
  // Then: this test goes red if the validator would trust that stub -- the
  // exact P16 failure mode (an empty spec vendored behind a success status).
  it('rejects the GitHub 200-with-empty-content stub for a blob past the 1MB inline limit', () => {
    const body = JSON.stringify({ size: 1333669, encoding: 'none', content: '' });
    expect(describeSpecDefect(body)).not.toBeNull();
  });

  it('rejects a non-JSON body', () => {
    expect(describeSpecDefect('not json')).toMatch(/not JSON/);
  });

  it('rejects a JSON array', () => {
    expect(describeSpecDefect('[]')).toMatch(/not a JSON object/);
  });

  it('rejects a document missing components.schemas', () => {
    const body = JSON.stringify({ openapi: '3.1.0', paths: {} });
    expect(describeSpecDefect(body)).toMatch(/components\.schemas/);
  });
});

describe('normalizeWithJq', () => {
  it('produces valid, re-parseable JSON equal in content to the input', () => {
    const input = '{"b":2,"a":1}';
    const output = normalizeWithJq(input).toString('utf8');
    expect(JSON.parse(output)).toEqual({ b: 2, a: 1 });
  });

  // When: the fetched payload contains \u-escaped non-ASCII characters (the
  // spec has 2,210 of them).
  // Then: this test goes red if normalizeWithJq does not decode them to real
  // UTF-8 -- the exact reason pull-spec.ts and check-spec-fresh.ts must share
  // this function rather than one normalising and the other not.
  it('decodes \\u escapes to real UTF-8', () => {
    const input = JSON.stringify({ description: 'café' });
    const output = normalizeWithJq(input).toString('utf8');
    expect(output).toContain('café');
  });

  it('is idempotent -- normalising already-normalised output changes nothing', () => {
    const once = normalizeWithJq('{"a":1}').toString('utf8');
    const twice = normalizeWithJq(once).toString('utf8');
    expect(twice).toBe(once);
  });
});

describe('readPin', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads and trims a well-formed 40-char hex SHA', () => {
    dir = mkdtempSync(join(tmpdir(), 'pin-test-'));
    const pinPath = join(dir, 'PIN');
    writeFileSync(pinPath, 'dd2fc4b502bc61159529ad51efce3ab51feeb6c9\n');
    expect(readPin(pinPath)).toBe('dd2fc4b502bc61159529ad51efce3ab51feeb6c9');
  });

  // When: spec/PIN is hand-edited into something that is not a 40-char hex SHA.
  // Then: this test goes red if readPin would silently pass a malformed pin
  // downstream -- catches the CLI's hand-synced-SHA failure mode right at the
  // single source of truth, instead of as a confusing gh api 404 three calls
  // later.
  it('rejects a malformed pin', () => {
    dir = mkdtempSync(join(tmpdir(), 'pin-test-'));
    const pinPath = join(dir, 'PIN');
    writeFileSync(pinPath, 'not-a-sha\n');
    expect(() => readPin(pinPath)).toThrow(/40-char hex SHA/);
  });
});

describe('writeAtomic', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes the target file with the given bytes', () => {
    dir = mkdtempSync(join(tmpdir(), 'spec-source-test-'));
    const target = join(dir, 'openapi.json');
    writeAtomic(target, Buffer.from('{"a":1}'));
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}');
  });

  // When: a write completes successfully.
  // Then: this test goes red if the temp file used to make the write atomic
  // is left behind -- the atomicity mechanism must clean up after itself.
  it('leaves no temp file behind on success', () => {
    dir = mkdtempSync(join(tmpdir(), 'spec-source-test-'));
    const target = join(dir, 'openapi.json');
    writeAtomic(target, Buffer.from('{}'));
    expect(readdirSync(dir)).toEqual(['openapi.json']);
  });

  it('overwrites an existing target rather than appending', () => {
    dir = mkdtempSync(join(tmpdir(), 'spec-source-test-'));
    const target = join(dir, 'openapi.json');
    writeAtomic(target, Buffer.from('{"a":1}'));
    writeAtomic(target, Buffer.from('{"b":2}'));
    expect(readFileSync(target, 'utf8')).toBe('{"b":2}');
  });
});
