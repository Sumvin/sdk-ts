import type { Client, ResolvedRequestOptions } from '../generated/client/index.js';
import { getParseAs } from '../generated/client/utils.gen.js';
import { ContractDriftError } from './contract-drift-error.js';
import { STRICT_OPERATIONS } from './strict-operations.js';
import { truncateForDrift } from './truncate-for-drift.js';
import type { ContractDriftEvent, ValidationOptions, ValidationTier } from './types.js';
import { VALIDATED_OPERATIONS } from './validated-operations.js';

/**
 * Which of {@link ContractDriftReason}'s "the client will never hand this
 * response to `responseValidator`" reasons applies, or `null` when the
 * client WILL attempt to parse this response as JSON.
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
 *
 * Splits what was a single boolean into two distinct reasons (FIX 2, filed
 * against the original single-reason version): an explicit, non-`'auto'`
 * `parseAs` is the CALLER opting out of JSON parsing — `'parse-as-opts-out-of-json'`
 * — which is a materially different remediation from the SERVER actually
 * sending an empty body or the wrong `Content-Type` while `parseAs` was left
 * at its default — `'empty-or-non-json-response'`. Mirrors the client's own
 * branches verbatim — same header name, same {@link getParseAs} helper — so
 * this can never disagree with what the client is about to do with this
 * exact response.
 */
function skipsResponseValidator(
  response: Response,
  parseAsOption: ResolvedRequestOptions['parseAs'],
): 'empty-or-non-json-response' | 'parse-as-opts-out-of-json' | null {
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return 'empty-or-non-json-response';
  }

  const resolvedParseAs =
    (parseAsOption === 'auto' ? getParseAs(response.headers.get('Content-Type')) : parseAsOption) ??
    'json';
  if (resolvedParseAs === 'json') {
    return null;
  }

  const isDeliberateOverride = parseAsOption !== undefined && parseAsOption !== 'auto';
  return isDeliberateOverride ? 'parse-as-opts-out-of-json' : 'empty-or-non-json-response';
}

/**
 * The `SyntaxError` `JSON.parse` throws over `response`'s body, or
 * `undefined` when it parses cleanly.
 *
 * Reads `response.clone()`, never `response` itself — the generated client
 * (`generated/client/client.gen.ts`) still needs to read the ORIGINAL,
 * unconsumed body itself immediately after this response interceptor
 * returns (its own `response.text()` call, one line before its own
 * `JSON.parse`). Only called when {@link skipsResponseValidator} returned
 * `null` — i.e. the client is about to attempt `JSON.parse` on this exact
 * body — so this can never disagree with what the client does next.
 *
 * FIX 1 (fifth vector of the original strict-tier finding): unguarded, that
 * `JSON.parse` throwing is caught by the generated client's OWN outer
 * try/catch, which routes it through `interceptors.error` with `response`
 * still defined — `installErrorInterceptor` (`src/errors/interceptor.ts`,
 * out of this module's scope) then has no way to tell "the body was not
 * JSON" from any other unusable error shape and falls through to its
 * generic tier-3 message, reporting the response's own 2xx `status` as an
 * HTTP failure and discarding the `SyntaxError` entirely. Checking here,
 * BEFORE the client's own parse step, is what lets a `strict` operation
 * fail closed with a reason that actually names what happened and a
 * preserved `cause`, instead of a misleading generic one two layers away.
 */
async function detectUnparsableJson(response: Response): Promise<SyntaxError | undefined> {
  const text = await response.clone().text();
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    return error instanceof SyntaxError ? error : new SyntaxError(String(error));
  }
}

/**
 * Installs response-body validation on a generated {@link Client}.
 *
 * This is the app's proven seam, adopted verbatim: `Config.responseValidator`
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
 * A `response.ok` reply that the client would never hand to `responseValidator` in the
 * first place — see {@link skipsResponseValidator} — is reported through `onContractDrift`
 * at either tier and additionally fails a **strict** operation's call closed (FIX 3,
 * posture check: this used to only fire for `strict`, so an `observe`-tier validated
 * operation's `204`/wrong-Content-Type reply produced no drift event at all — the same
 * "fire at both, fail closed only at strict" shape `unparsable-json-response` already
 * used a few lines below). `observe` is scoped to operations that HAVE a schema (a
 * `VALIDATED_OPERATIONS` entry), same reasoning as that check. Every one of the 17
 * `STRICT_OPERATIONS` keys declares exactly one `200 application/json` success response
 * in `spec/openapi.json` (checked directly, not assumed — none declares a `204` or an
 * empty/non-JSON success body), so the strict half of this rule applies uniformly to all
 * 17 with no per-operation carve-out.
 *
 * A response the client WILL hand to `responseValidator` can still never reach it: a
 * `200 application/json` reply whose body is not valid JSON at all makes the client's
 * own `JSON.parse` throw first — see {@link detectUnparsableJson} (FIX 1). Checked for
 * `strict` operations and for any `observe`-tier operation that HAS a schema (i.e. is a
 * `VALIDATED_OPERATIONS` entry) — an unparseable body is a contract violation at either
 * tier, so `onContractDrift` fires for both; only `strict` additionally fails closed.
 * `observe` is deliberately NOT extended to every possible operation, validated or not:
 * this check reads the body via `response.clone()`, and paying that cost for operations
 * this module was never asked to validate at all would be pure overhead with no signal
 * behind it.
 *
 * Call this once per {@link Client} — typically from `createSumvinClient` (Phase C).
 * A consumer who only wants curated validation on top of the generated client (no
 * other curated behaviour) can call it directly against a client of their own.
 */
export function installResponseValidation(client: Client, options: ValidationOptions = {}): void {
  const operations = options.operations ?? VALIDATED_OPERATIONS;
  const strictOperations = options.strictOperations ?? STRICT_OPERATIONS;
  const onContractDrift = options.onContractDrift;

  client.interceptors.response.use(async (response, _request, opts) => {
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

    const skipReason = skipsResponseValidator(response, opts.parseAs);
    if (skipReason !== null) {
      // FIX 3 (posture check): report at both tiers, matching
      // unparsable-json-response's own tier boundary below — an
      // unvalidated-shape response is a contract violation at either
      // severity, only `strict` additionally fails the call closed. Scoped
      // to `strict` or "has a schema" (same reasoning as the
      // detectUnparsableJson gate a few lines down): reporting on every
      // observe-tier operation, validated or not, would be signal-free
      // noise for operations this module was never asked to validate.
      if (tier === 'strict' || schema !== undefined) {
        const event: ContractDriftEvent = {
          operationKey,
          tier,
          reason: skipReason,
          value: truncateForDrift({
            status: response.status,
            contentType: response.headers.get('Content-Type'),
            contentLength: response.headers.get('Content-Length'),
          }),
        };
        onContractDrift?.(event);
        if (tier === 'strict') {
          // Assigning `opts.responseValidator` below would never run — the
          // client itself never reaches it for this response (see
          // `skipsResponseValidator`). Fail closed from the interceptor
          // instead: throwing here is caught by the generated client's own
          // request try/catch and routed through `interceptors.error`, the
          // exact same path a throwing `responseValidator` takes below —
          // including `installErrorInterceptor`'s bypass that lets a
          // `ContractDriftError` through unchanged.
          throw new ContractDriftError(event);
        }
      }
      return response;
    }

    if (tier === 'strict' || schema !== undefined) {
      const parseError = await detectUnparsableJson(response);
      if (parseError) {
        const event: ContractDriftEvent = {
          operationKey,
          tier,
          reason: 'unparsable-json-response',
          cause: parseError,
          value: truncateForDrift({
            status: response.status,
            contentType: response.headers.get('Content-Type'),
          }),
        };
        onContractDrift?.(event);
        if (tier === 'strict') {
          // Same routing as the skip-reason throw above: caught by the
          // generated client's outer try/catch, passed through
          // `installErrorInterceptor` unchanged.
          throw new ContractDriftError(event);
        }
        // `observe`: reported, not enforced. The response body is left
        // exactly as received (only `.clone()` was read) — the generated
        // client goes on to attempt its own `JSON.parse` over the SAME
        // unparseable text immediately after this interceptor returns, and
        // whatever it and `installErrorInterceptor` do with that failure is
        // unchanged by this module, same as any other operation without a
        // strict-tier failure guard.
        return response;
      }
    }

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
