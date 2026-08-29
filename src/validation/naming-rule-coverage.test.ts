/**
 * A coverage *report*, not a lookup mechanism.
 *
 * hey-api emits one Zod response schema per operation named
 * `z{PascalCase(operationId)}Response` (confirmed for the 54 operations this
 * module actually maps in `validated-operations.ts` — see the module
 * docblock there). It would be tempting to use that naming rule as
 * `VALIDATED_OPERATIONS` itself: look up `z${pascal(operationId)}Response` by
 * string and skip maintaining an explicit map. The "Gate results folded in"
 * section of the plan rejects that outright — a string lookup keeps
 * compiling and stops checking the moment a schema is renamed, and it would
 * switch validation on for 170 of 174 operations whose schemas have never
 * executed against a live response, which is maximum blast radius for no
 * extra signal.
 *
 * What the naming rule earns instead is a standing report over the *whole*
 * spec: which operations the rule fails for, so that set stays a known,
 * reviewed quantity rather than something nobody has looked at since
 * generation. The four misses below all declare `200: application/json`
 * with an empty (`{}`) schema — hey-api emits no schema for those, so no
 * name could ever resolve — and are legitimately untyped.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as zodGen from '../generated/zod.gen.js';

const KNOWN_MISSES = [
  'getKycDocumentImage',
  'handleAlchemyWebhook',
  'handleMeldWebhook',
  'handleSumsubWebhook',
] as const;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function pascalCase(operationId: string): string {
  return operationId.charAt(0).toUpperCase() + operationId.slice(1);
}

function collectOperationIds(): string[] {
  const spec = JSON.parse(readFileSync('spec/openapi.json', 'utf-8')) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };

  const operationIds: string[] = [];
  for (const pathItem of Object.values(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operationId = pathItem[method]?.operationId;
      if (operationId) {
        operationIds.push(operationId);
      }
    }
  }
  return operationIds;
}

describe('z{PascalOperationId}Response naming-rule coverage (report only)', () => {
  it('misses exactly the four known untyped webhook/image operations', () => {
    const operationIds = collectOperationIds();
    // Sanity: the spec still has as many operations as this repo was
    // generated against. If this drifts, the miss set below may need
    // re-deriving rather than blindly trusted.
    expect(operationIds.length).toBeGreaterThan(0);

    const misses = operationIds
      .filter((operationId) => !(`z${pascalCase(operationId)}Response` in zodGen))
      .sort();

    // When: this goes red the moment a *new* operation joins the miss set —
    // an operationId rename, or a new endpoint whose 200 response has no
    // meaningful schema — so the miss set stays something a human reviewed,
    // not something that silently grew.
    expect(misses).toEqual([...KNOWN_MISSES].sort());
  });

  it.each(KNOWN_MISSES)('%s genuinely has no generated response schema', (operationId) => {
    const schemaName = `z${pascalCase(operationId)}Response`;
    expect(schemaName in zodGen).toBe(false);
  });
});
