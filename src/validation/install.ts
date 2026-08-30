import type { Client, ResolvedRequestOptions } from '../generated/client/index.js';
import { getParseAs } from '../generated/client/utils.gen.js';
import { ContractDriftError } from './contract-drift-error.js';
import { STRICT_OPERATIONS } from './strict-operations.js';
import { truncateForDrift } from './truncate-for-drift.js';
import type { ContractDriftEvent, ValidationOptions, ValidationTier } from './types.js';
import { VALIDATED_OPERATIONS } from './validated-operations.js';

/**
 * True exactly when the generated client's own parse step
 * (`generated/client/client.gen.ts`) will never call `options.responseValidator`
 * for this response at all — a `204`, an explicit `Content-Length: 0`, or a
 * `Content-Type` that resolves (via the SAME {@link getParseAs} the client
 * itself calls) to anything other than `'json'`. Mirrors the client's two
 * branches verbatim — same header name, same helper — so this can never
 * disagree with what the client is about to do with this exact response.
 *
 * Found by reproduction (FIX 2, both an adversarial verification pass and a
 * posture check, independently): `installResponseValidation` assigns
 * `opts.responseValidator`, but the client only reaches that assignment for
 * a non-empty, `parseAs === 'json'` response — a strict operation's `204`,
 * `Content-Length: 0`, `text/plain`, or `application/octet-stream` reply
 * sails past every check this module installs and comes back as `{}` (or
 * raw text/bytes) with no error and no drift event. On
 * `GET /v0/budgets/{budget_id}` — strict because its body "drives the
 * remaining-spend calculation shown as currency" — that `{}` is exactly what
 * a caller's `data.remaining ?? 0` reads as a real zero.
 */
function bypassesJsonParsing(
  response: Response,
  parseAsOption: ResolvedRequestOptions['parseAs'],
): boolean {
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return true;
  }

  const resolvedParseAs =
    (parseAsOption === 'auto' ? getParseAs(response.headers.get('Content-Type')) : parseAsOption) ??
    'json';
  return resolvedParseAs !== 'json';
}

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
 * The `response.ok` guard is **defense-in-depth, not load-bearing against the
 * generated client as it stands today** — corrected here (FIX 4, both an
 * adversarial verification pass and a posture check found this independently):
 * a prior version of this comment claimed the guard was load-bearing because
 * "interceptors fire on 4xx responses too (`./seam.test.ts`, `./install.test.ts`
 * both prove it)". That premise is true and the conclusion drawn from it was
 * not — those two files prove response interceptors RUN on a 4xx `response`,
 * which is real but irrelevant here: `generated/client/client.gen.ts` only
 * ever reaches its own `if (response.ok) { … opts.responseValidator(data) … }`
 * branch for a successful response, so an *assigned* `opts.responseValidator`
 * is simply never called on a 4xx today, guard or no guard — proven by
 * removing the guard outright and re-running the full suite: all 34 tests,
 * including both files' own "fires on 4xx" cases, stayed green. The guard is
 * kept anyway as a second, independent line of defense: if a future
 * `@hey-api/openapi-ts` upgrade ever starts invoking `responseValidator`
 * outside the `response.ok` branch, this is the one line standing between
 * that upgrade and every error response silently being checked against a 2xx
 * success schema and firing a spurious drift event.
 *
 * A **strict** operation additionally fails closed on a `response.ok` reply that the
 * client would never hand to `responseValidator` in the first place — see
 * {@link bypassesJsonParsing}. Every one of the 17 `STRICT_OPERATIONS` keys declares
 * exactly one `200 application/json` success response in `spec/openapi.json` (checked
 * directly, not assumed — none declares a `204` or an empty/non-JSON success body), so
 * this rule applies uniformly to all 17 with no per-operation carve-out.
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

    if (tier === 'strict' && bypassesJsonParsing(response, opts.parseAs)) {
      // Assigning `opts.responseValidator` below would never run — the
      // client itself never reaches it for this response (see
      // `bypassesJsonParsing`). Fail closed from the interceptor instead:
      // throwing here is caught by the generated client's own request
      // try/catch and routed through `interceptors.error`, the exact same
      // path a throwing `responseValidator` takes below — including
      // `installErrorInterceptor`'s bypass that lets a `ContractDriftError`
      // through unchanged.
      const event: ContractDriftEvent = {
        operationKey,
        tier,
        reason: 'empty-or-non-json-response',
        value: truncateForDrift({
          status: response.status,
          contentType: response.headers.get('Content-Type'),
          contentLength: response.headers.get('Content-Length'),
        }),
      };
      onContractDrift?.(event);
      throw new ContractDriftError(event);
    }

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
