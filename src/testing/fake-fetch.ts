/**
 * A scripted `fetch` for tests.
 *
 * The generated client takes a `fetch` through {@link Config.fetch}, so every
 * curated behaviour — auth headers, validation tiers, error normalization, HAL
 * following — can be exercised end to end without a network, a mock library, or
 * a running API. This is the same shape sumvin-cli's tests use: capture the
 * outgoing {@link Request}, hand back a scripted {@link Response}.
 *
 * Test-only. Nothing here is exported from a package entry point, so it never
 * reaches `dist/`.
 */

/** One scripted reply. `body` is JSON-encoded unless it is already a string. */
export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of replying — models a network failure, DNS error, or abort. */
  throws?: Error;
}

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
    return new Response(bodyless ? null : body, { status, headers });
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
