import type { Client } from '../generated/client/index.js';
import { ContractDriftError } from './contract-drift-error.js';
import { STRICT_OPERATIONS } from './strict-operations.js';
import { truncateForDrift } from './truncate-for-drift.js';
import type { ContractDriftEvent, ValidationOptions, ValidationTier } from './types.js';
import { VALIDATED_OPERATIONS } from './validated-operations.js';

/**
 * Installs response-body validation on a generated {@link Client}.
 *
 * This is the app's proven seam (D4), adopted verbatim: `Config.responseValidator`
 * has no per-operation context (it is a bare `(data) => Promise<unknown>`), and a
 * response interceptor cannot read the body itself — under Bun that throws a plain
 * `TypeError: Body already used` because the client's own parse step then finds the
 * stream already consumed. Instead this registers a **response interceptor** that,
 * for a `response.ok` reply, *assigns* `options.responseValidator` — a function the
 * client calls itself, after interceptors run and after it has already parsed the
 * body. Assigning it costs nothing the client wasn't already going to do; reading
 * the body here would.
 *
 * The `response.ok` guard is load-bearing, not decoration: interceptors fire on 4xx
 * responses too (`./seam.test.ts`, `./install.test.ts` both prove it), and without
 * the guard every error response would be checked against a 2xx success schema and
 * emit a spurious drift event.
 *
 * Call this once per {@link Client} — typically from `createSumvinClient` (Phase C).
 * A consumer who only wants curated validation on top of the generated client (no
 * other curated behaviour) can call it directly against a client of their own.
 */
export function installResponseValidation(client: Client, options: ValidationOptions = {}): void {
  const operations = options.operations ?? VALIDATED_OPERATIONS;
  const strictOperations = options.strictOperations ?? STRICT_OPERATIONS;
  const onContractDrift = options.onContractDrift;

  client.interceptors.response.use((response, _request, opts) => {
    if (!response.ok) {
      return response;
    }

    // `opts.url` is the un-substituted path template, not the resolved
    // request URL — see `./seam.test.ts` for the standing proof. That is
    // exactly what lets this key match `VALIDATED_OPERATIONS` /
    // `STRICT_OPERATIONS` by operation identity, regardless of the caller's
    // actual path-parameter values.
    const operationKey = `${opts.method} ${opts.url}`;
    const tier: ValidationTier = operationKey in strictOperations ? 'strict' : 'observe';
    const schema = operations[operationKey];

    if (!schema) {
      // Not validated at all — UNLESS it is a strict key that fell out of
      // (or was never given) a schema. That case must never pass silently:
      // a strict money operation with no schema to check is reported and
      // failed closed, with a reason distinct from an ordinary mismatch.
      if (tier === 'strict') {
        opts.responseValidator = async (data) => {
          const event: ContractDriftEvent = {
            operationKey,
            tier,
            reason: 'strict-operation-unvalidated',
            value: truncateForDrift(data),
          };
          onContractDrift?.(event);
          throw new ContractDriftError(event);
        };
      }
      return response;
    }

    opts.responseValidator = async (data) => {
      const result = schema.safeParse(data);
      if (result.success) {
        return;
      }

      const event: ContractDriftEvent = {
        operationKey,
        tier,
        reason: 'schema-mismatch',
        issues: result.error.issues,
        value: truncateForDrift(data),
      };
      onContractDrift?.(event);

      if (tier === 'strict') {
        throw new ContractDriftError(event);
      }
      // `observe`: reported, not enforced — the client discards this
      // function's return value either way, so the parsed body reaches the
      // caller unchanged.
    };

    return response;
  });
}
