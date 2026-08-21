import { describe, expect, it } from 'vitest';
import type { OpenApiSpecLike, SecurityRequirementSet } from './security-diff';
import { computeSecurityDiff, formatSecurityDiff, hasChanges } from './security-diff';

function makeSpec(
  schemes: Record<string, { type: string; in: string; name: string }>,
  ops: Record<string, { path: string; method: string; security?: SecurityRequirementSet }>,
): OpenApiSpecLike {
  const paths: NonNullable<OpenApiSpecLike['paths']> = {};
  for (const [operationId, op] of Object.entries(ops)) {
    paths[op.path] ??= {};
    paths[op.path][op.method] = {
      operationId,
      ...(op.security !== undefined ? { security: op.security } : {}),
    };
  }
  return { components: { securitySchemes: schemes }, paths };
}

const BASE_SCHEMES = {
  JunoJWT: { type: 'apiKey', in: 'header', name: 'x-juno-jwt' },
  SumvinPAT: { type: 'apiKey', in: 'header', name: 'x-sumvin-pat' },
};

const BASE_OPS = {
  getUserMe: { path: '/v0/user/me', method: 'get', security: [{ JunoJWT: [] }] },
  listPublicThing: { path: '/v0/public/thing', method: 'get', security: [] },
};

describe('computeSecurityDiff', () => {
  // When: nothing about security changed between two specs.
  // Then: this test goes red if computeSecurityDiff invents a difference
  // between two identical specs.
  it('reports no changes for two identical specs', () => {
    const a = makeSpec(BASE_SCHEMES, BASE_OPS);
    const b = makeSpec(BASE_SCHEMES, BASE_OPS);
    const diff = computeSecurityDiff(a, b);
    expect(hasChanges(diff)).toBe(false);
    expect(formatSecurityDiff(diff)).toBe('No security changes.');
  });

  // When: a security scheme is deleted from components.securitySchemes.
  // Then: this test goes red if computeSecurityDiff fails to name the
  // removed scheme.
  it('reports a removed security scheme', () => {
    const a = makeSpec(BASE_SCHEMES, BASE_OPS);
    const { SumvinPAT: _dropped, ...remaining } = BASE_SCHEMES;
    const b = makeSpec(remaining, BASE_OPS);
    const diff = computeSecurityDiff(a, b);
    expect(diff.schemesRemoved).toEqual(['SumvinPAT']);
    expect(hasChanges(diff)).toBe(true);
    expect(formatSecurityDiff(diff)).toContain('SumvinPAT');
  });

  it('reports an added security scheme', () => {
    const a = makeSpec(BASE_SCHEMES, BASE_OPS);
    const b = makeSpec(
      { ...BASE_SCHEMES, UcpToken: { type: 'apiKey', in: 'header', name: 'x-sumvin-ucp-token' } },
      BASE_OPS,
    );
    const diff = computeSecurityDiff(a, b);
    expect(diff.schemesAdded).toEqual(['UcpToken']);
  });

  // When: a scheme's header `name` field moves.
  // Then: this test goes red if computeSecurityDiff fails to name the moved
  // scheme and its old/new header -- the header-move mutation proof from the
  // plan.
  it('reports a scheme whose header name moved', () => {
    const a = makeSpec(BASE_SCHEMES, BASE_OPS);
    const b = makeSpec(
      { ...BASE_SCHEMES, SumvinPAT: { ...BASE_SCHEMES.SumvinPAT, name: 'x-sumvin-moved' } },
      BASE_OPS,
    );
    const diff = computeSecurityDiff(a, b);
    expect(diff.schemesMoved).toEqual([
      { scheme: 'SumvinPAT', oldName: 'x-sumvin-pat', newName: 'x-sumvin-moved' },
    ]);
    expect(formatSecurityDiff(diff)).toContain('x-sumvin-pat');
    expect(formatSecurityDiff(diff)).toContain('x-sumvin-moved');
  });

  // When: an operation stops requiring any credential (security: []).
  // Then: this test goes red if the change is not reported AND flagged as
  // the dangerous direction: an operation that stopped requiring a credential
  // is strictly worse than one that started requiring a new one.
  it('flags an operation that stopped requiring a credential as dangerous', () => {
    const a = makeSpec(BASE_SCHEMES, BASE_OPS);
    const b = makeSpec(BASE_SCHEMES, {
      ...BASE_OPS,
      getUserMe: { ...BASE_OPS.getUserMe, security: [] },
    });
    const diff = computeSecurityDiff(a, b);
    expect(diff.operationChanges).toHaveLength(1);
    expect(diff.operationChanges[0]?.operationId).toBe('getUserMe');
    expect(diff.operationChanges[0]?.droppedCredential).toBe(true);
    expect(formatSecurityDiff(diff)).toContain('DANGEROUS');
  });

  // When: an operation starts requiring a credential it did not before.
  // Then: this test goes red if the change is not reported, or if it is
  // wrongly flagged dangerous -- only the credential-dropped direction is
  // dangerous, not the credential-added direction.
  it('reports an operation that started requiring a credential, not flagged dangerous', () => {
    const a = makeSpec(BASE_SCHEMES, BASE_OPS);
    const b = makeSpec(BASE_SCHEMES, {
      ...BASE_OPS,
      listPublicThing: { ...BASE_OPS.listPublicThing, security: [{ JunoJWT: [] }] },
    });
    const diff = computeSecurityDiff(a, b);
    expect(diff.operationChanges).toHaveLength(1);
    expect(diff.operationChanges[0]?.operationId).toBe('listPublicThing');
    expect(diff.operationChanges[0]?.droppedCredential).toBe(false);
    expect(formatSecurityDiff(diff)).not.toContain('DANGEROUS');
  });

  // When: only the order of alternatives/scopes changes, not their content.
  // Then: this test goes red if computeSecurityDiff reports a false-positive
  // change from reordering alone -- it must canonicalise before comparing.
  it('treats reordering of alternatives and scopes as no change', () => {
    const a = makeSpec(BASE_SCHEMES, {
      getUserMe: {
        path: '/v0/user/me',
        method: 'get',
        security: [{ JunoJWT: ['read', 'write'] }, { SumvinPAT: [] }],
      },
    });
    const b = makeSpec(BASE_SCHEMES, {
      getUserMe: {
        path: '/v0/user/me',
        method: 'get',
        security: [{ SumvinPAT: [] }, { JunoJWT: ['write', 'read'] }],
      },
    });
    const diff = computeSecurityDiff(a, b);
    expect(hasChanges(diff)).toBe(false);
  });
});
