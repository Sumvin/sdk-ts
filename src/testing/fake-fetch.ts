/**
 * A scripted `fetch` for tests.
 *
 * The generated client takes a `fetch` through {@link Config.fetch}, so every
 * curated behaviour — auth headers, validation tiers, error normalization, HAL
 * following — can be exercised end to end without a network, a mock library, or
 * a running API. This is the same shape sumvin-cli's tests use: capture the
 * outgoing {@link Request}, hand back a scripted {@link Response}.
 *
 * Test-only, and published for exactly that: `@sumvin/sdk/testing` (see
 * `src/testing/index.ts`) is a public subpath a consumer installs to test
 * their own code against this SDK's real transport, never to import from
 * production code.
 */

/**
 * One scripted reply. `body` is JSON-encoded unless it is already a string.
 *
 * `redirected` and `url` default to a hand-constructed `Response`'s own
 * defaults (`false` / `''`) when omitted — scripting either one applies it
 * to the constructed `Response` via an instance-level `Object.defineProperty`
 * override (both are read-only getters on the `Response` prototype; plain
 * assignment throws). Without this, every scripted reply is indistinguishable
 * from an ordinary non-redirected response, so a test asserting a
 * redirect-refusal backstop actually fires (e.g. `src/auth/interceptor.ts`'s
 * `redirectRefusalReason`) would pass whether or not that backstop's
 * `response.redirected` check does anything at all — the exact vacuous-fake
 * defect this module exists to not have.
 *
 * The override is an own-property and does **not** survive `Response.clone()`
 * — a cloned `Response` reports the prototype defaults again, on every
 * runtime this repo targets. That is safe today only because the one place
 * this SDK clones a response to read its body
 * (`src/validation/install.ts`'s `detectUnparsableJson`) discards the clone
 * and returns the *original* response onward — see this file's own test for
 * the pinned proof. A future refactor that started handing the clone onward
 * instead would silently make every redirect-backstop test written against
 * this fake vacuous again.
 */
export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of replying — models a network failure, DNS error, or abort. */
  throws?: Error;
  /**
   * `Response.redirected` on the constructed reply. Omit to keep the
   * hand-constructed-`Response` default (`false`).
   */
  redirected?: boolean;
  /**
   * `Response.url` on the constructed reply. Omit to keep the
   * hand-constructed-`Response` default (`''`).
   */
  url?: string;
}

/** A `fetch` scripted by {@link fakeFetch}, plus the record of what it received. */
export interface FakeFetch {
  /** The `fetch` implementation to hand to `createSumvinClient({ fetch })`. */
  readonly fetch: typeof fetch;
  /** Every request made, in order. */
  readonly calls: readonly Request[];
  /** The most recent request. Throws if nothing has been requested yet. */
  last(): Request;
  /** Header value from the most recent request, or `null`. */
  lastHeader(name: string): string | null;
  /** Parsed JSON body of the most recent request, or `undefined` if it had none. */
  lastBody(): Promise<unknown>;
}

/**
 * Build a `fetch` that replies with `replies` in order.
 *
 * The final reply repeats once the script is exhausted, so a polling test can
 * script `[pending, pending, done]` without also scripting the exact number of
 * polls the implementation happens to make. Scripting a single reply therefore
 * makes every request receive it.
 *
 * @example
 * const f = fakeFetch([{ status: 202, body: { id: 'x' } }]);
 * const client = createSumvinClient({ baseUrl: 'https://api.test', fetch: f.fetch });
 * await createIpa({ client, body });
 * expect(f.last().method).toBe('POST');
 */
export function fakeFetch(replies: FakeReply[]): FakeFetch {
  if (replies.length === 0) {
    throw new Error('fakeFetch needs at least one reply');
  }

  const calls: Request[] = [];
  let index = 0;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(request.clone());

    const reply = replies[Math.min(index, replies.length - 1)] as FakeReply;
    index += 1;

    if (reply.throws) {
      throw reply.throws;
    }

    const status = reply.status ?? 200;
    const headers = new Headers(reply.headers);
    let body: string | null = null;

    if (reply.body !== undefined) {
      body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      if (!headers.has('content-type')) {
        // The API serves RFC 7807 problems as `application/json`, never
        // `application/problem+json` — mirroring that here is what keeps the
        // error parser honest about detecting problems by shape, not by type.
        headers.set('content-type', 'application/json');
      }
    }

    // 204 and 304 must not carry a body; constructing one throws in undici.
    const bodyless = status === 204 || status === 304;
    const response = new Response(bodyless ? null : body, { status, headers });

    // `redirected` and `url` are read-only getters on `Response.prototype`
    // (plain assignment throws) — an instance-level `defineProperty`
    // override works on Node, Bun and browsers alike; patching the
    // PROTOTYPE does not (Bun's prototype descriptors are
    // `configurable: false` where Node's are `true`, so a
    // prototype-patching implementation would pass on Node and fail on
    // Bun). See this interface's own TSDoc on `FakeReply` for why this
    // matters and what it does not survive (`.clone()`).
    if (reply.redirected !== undefined) {
      Object.defineProperty(response, 'redirected', { value: reply.redirected });
    }
    if (reply.url !== undefined) {
      Object.defineProperty(response, 'url', { value: reply.url });
    }

    return response;
  }) as typeof fetch;

  return {
    fetch: impl,
    calls,
    last() {
      const request = calls.at(-1);
      if (!request) {
        throw new Error('fakeFetch: no request has been made yet');
      }
      return request;
    },
    lastHeader(name) {
      return this.last().headers.get(name);
    },
    async lastBody() {
      const request = this.last().clone();
      const text = await request.text();
      return text ? JSON.parse(text) : undefined;
    },
  };
}
