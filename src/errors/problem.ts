/**
 * RFC 7807 problem-detail parsing, in three tiers, ported (parsing logic
 * only — not the CLI's `FRIENDLY_MESSAGES`/`NEXT_STEPS` presentation tables)
 * from sumvin-cli `src/runtime/problem.ts:627-655`.
 *
 * Detection is by SHAPE, never by `Content-Type`: the API serves every
 * `ProblemDetail` as `application/json`, never `application/problem+json`
 * (zero occurrences in the vendored spec — P3). A body counts as a genuine
 * `ProblemDetail` only when all six required fields (`type`, `title`,
 * `status`, `detail`, `instance`, `error_code`) are present with the right
 * primitive types.
 */
import type { ProblemDetail } from '../generated/types.gen.js';
import { ApiError } from './api-error.js';

/** Tier 1: every required `ProblemDetail` field, correctly typed. */
function isProblemDetail(body: unknown): body is ProblemDetail {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const b = body as Record<string, unknown>;
  return (
    typeof b.type === 'string' &&
    typeof b.title === 'string' &&
    typeof b.status === 'number' &&
    typeof b.detail === 'string' &&
    typeof b.instance === 'string' &&
    typeof b.error_code === 'string'
  );
}

/**
 * Tier 2: a body that carries a usable `title` but isn't a spec-conformant
 * `ProblemDetail` — e.g. a ProblemDetail-shaped body that dropped
 * `error_code` (spec drift). A raw Pydantic `HTTPValidationError`
 * (`{ detail: [...] }`, no `title` at all) does NOT match this, and
 * correctly falls through to the generic tier 3.
 */
function hasUsableTitle(body: unknown): body is { title: string; detail?: unknown } {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { title?: unknown }).title === 'string'
  );
}

/** Generic, tier-3 message for a non-ProblemDetail response, by status family. */
function genericStatusMessage(status: number | undefined): string {
  if (status === undefined) {
    return 'Request failed.';
  }
  if (status === 429 || status >= 500) {
    return `Sumvin is busy, please retry (HTTP ${status}).`;
  }
  return `Request failed with HTTP ${status}.`;
}

export interface ParseProblemParams {
  /** The already-parsed error value the generated client threw (JSON body, or raw text). */
  body: unknown;
  /** `response.status`. Always defined here — this is only called once a `Response` exists. */
  status: number;
  request: Request | undefined;
  response: Response;
}

/**
 * Converts an HTTP failure body into an {@link ApiError}, trying each tier in
 * order: a full `ProblemDetail`, then a title-only fallback, then a generic
 * message keyed by status.
 */
export function parseProblemBody(params: ParseProblemParams): ApiError {
  const { body, status, request, response } = params;

  if (isProblemDetail(body)) {
    return new ApiError({
      kind: 'problem',
      message: `${body.title}: ${body.detail} (${body.error_code})`,
      status: body.status,
      problem: body,
      errorCode: body.error_code,
      traceId: body.trace_id ?? undefined,
      request,
      response,
    });
  }

  if (hasUsableTitle(body)) {
    const detail =
      typeof body.detail === 'string' && body.detail.length > 0 ? body.detail : undefined;
    return new ApiError({
      kind: 'http',
      message: detail ? `${body.title}: ${detail}` : body.title,
      status,
      request,
      response,
    });
  }

  return new ApiError({
    kind: 'http',
    message: genericStatusMessage(status),
    status,
    request,
    response,
  });
}
