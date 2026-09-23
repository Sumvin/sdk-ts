/**
 * `AuthProvider` and the three header-scoped credential providers this SDK
 * ships: {@link junoJwt}, {@link sumvinPat}, {@link pintToken}.
 *
 * A provider only *supplies* a token on demand — it never stores one.
 * Storage (a keychain, an env var, an in-memory store, a React context) is
 * the consumer's job; see `./interceptor.js` for how these are installed and
 * why every configured provider that yields a token is applied additively,
 * never through `Config.auth`.
 *
 * **A credential-configured client sends every configured provider's header
 * to every operation, including ones that declare no security requirement at
 * all** (counted against `spec/openapi.json`: of 174 operations, 23
 * declare `PintBearer` and 151 do NOT but still receive a Stamped Mandate
 * header under this additive design, and 13 declare no security
 * whatsoever — the four webhook receivers, `POST /v0/cli/personal-access-tokens`,
 * and the public payment pages `GET /pay/{slug}` / `GET /v0/payment-links/public/{slug}`,
 * both plausibly sitting behind a request-logging CDN). The additive design
 * is correct for the problem it solves (see `./interceptor.js`),
 * but it is a reason to be deliberate about REUSING one credentialed client
 * for public or webhook-receiving calls, not a reason to assume it is safe.
 * See {@link AuthProvider.appliesTo} to bound a provider to only the
 * operations that should ever see its header.
 */

/** A value, or a promise of one — every provider's `getToken()` may be sync or async. */
export type Awaitable<T> = T | Promise<T>;

/**
 * Supplies one request header's credential, on demand, at request time.
 *
 * `getToken()` is called fresh for every request the auth interceptor runs
 * against — never cached by this SDK — so a getter-backed provider can hand
 * back a just-refreshed value on every call. Returning `undefined` means "no
 * credential available right now": a normal, non-error state (a logged-out
 * app, a CLI that hasn't signed in yet), not something to throw over.
 *
 * Implement this directly only for a credential this SDK doesn't ship a
 * factory for; {@link junoJwt}, {@link sumvinPat}, and {@link pintToken}
 * cover the three schemes a client needs (`x-sumvin-ucp-token` is declared in
 * the spec but is not a client credential, so it has no factory here).
 *
 * @example
 * const provider: AuthProvider = {
 *   header: 'x-my-header',
 *   getToken: () => myStore.getCurrentToken(),
 * };
 */
export interface AuthProvider {
  /** The exact request header this provider sets, e.g. `'x-juno-jwt'`. */
  readonly header: string;
  /** Returns the current credential, or `undefined` if none is available right now. */
  getToken(): Awaitable<string | undefined>;
  /**
   * Optional: bounds which operations this provider's header is set on.
   * Keyed the same way `src/validation` keys operations — `` `${METHOD}
   * ${path template}` ``, e.g. `'GET /v0/budgets/{budget_id}'` — read from
   * the SAME `options.method` / `options.url` a response interceptor sees
   * (`src/validation/seam.test.ts` is the standing proof this is the
   * un-substituted template, not the caller's resolved path). Omit to keep
   * today's default: applies to every request, unconditionally.
   *
   * Exists to let a consumer narrow a provider away from operations it was
   * never meant to reach — see this module's own TSDoc for the quantified
   * reason (13 operations declare no security requirement at all,
   * including the four webhook receivers and two public payment pages).
   * `getToken()` is still called first regardless of `appliesTo`
   * (this only gates whether the RESULT is applied to a given request), so
   * a provider whose token-fetch has its own side effects still runs one
   * per request — narrow the provider's own `getToken` if that matters too.
   *
   * @example
   * // A Stamped Mandate provider that never rides along on a webhook receiver
   * // or a public payment page, even though the additive design would
   * // otherwise send it there:
   * pintToken(() => currentPint?.token, {
   *   appliesTo: (operationKey) => !operationKey.includes('/webhooks/'),
   * });
   */
  appliesTo?(operationKey: string): boolean;
}

/**
 * A static string, or a getter that supplies one (sync or async). Accepted
 * by {@link sumvinPat} and {@link pintToken} — {@link junoJwt} deliberately
 * does not accept a static string; see its TSDoc for why.
 */
export type TokenOrGetter = string | (() => Awaitable<string | undefined>);

/** Optional second argument shared by every factory below — see {@link AuthProvider.appliesTo}. */
export interface ProviderOptions {
  /** Bounds which operations this provider's header is set on. Omit to apply to every request. */
  appliesTo?: (operationKey: string) => boolean;
}

function resolve(tokenOrGetter: TokenOrGetter): Awaitable<string | undefined> {
  return typeof tokenOrGetter === 'function' ? tokenOrGetter() : tokenOrGetter;
}

/**
 * `x-juno-jwt` provider — the Sumvin app's session credential.
 *
 * **Getter-first, deliberately**: unlike {@link sumvinPat} and
 * {@link pintToken}, this factory accepts only a getter, never a static
 * string. A JWT is short-lived and the consuming app refreshes it
 * independently of this SDK (a session store, a refresh interceptor); a
 * static string here would silently go stale the moment the app rotated its
 * session token, and there would be no way to recover without constructing
 * a brand new client.
 *
 * @example
 * const provider = junoJwt(() => authStore.getState().jwt);
 * const client = createSumvinClient({ baseUrl, auth: [provider] });
 */
export function junoJwt(
  getter: () => Awaitable<string | undefined>,
  options?: ProviderOptions,
): AuthProvider {
  return {
    header: 'x-juno-jwt',
    getToken: () => getter(),
    appliesTo: options?.appliesTo,
  };
}

/**
 * `x-sumvin-pat` provider — a CLI or script's personal access token.
 *
 * @example
 * const provider = sumvinPat(process.env.SUMVIN_PAT);
 * @example
 * // Or a getter, for a token re-read from a credential store on every call:
 * const provider = sumvinPat(() => readStoredPat());
 */
export function sumvinPat(tokenOrGetter: TokenOrGetter, options?: ProviderOptions): AuthProvider {
  return {
    header: 'x-sumvin-pat',
    getToken: () => resolve(tokenOrGetter),
    appliesTo: options?.appliesTo,
  };
}

/**
 * `x-sumvin-pint-token` provider — an agent's Stamped Mandate token.
 *
 * Set **alongside**, never instead of, a base-credential provider
 * ({@link junoJwt} or {@link sumvinPat}) — see `./interceptor.js` for why.
 * The server identifies the caller from the base credential first, and only
 * then reads the Stamped Mandate header, so swapping one
 * scheme for another per operation (the way `Config.auth` would) can
 * silently drop whichever header the server's per-operation `security`
 * metadata didn't select.
 *
 * @example
 * const client = createSumvinClient({
 *   baseUrl,
 *   auth: [sumvinPat(pat), pintToken(() => currentPint?.token)],
 * });
 * @example
 * // Bounded away from the operations that declare no security requirement
 * // at all (see this module's own TSDoc for the quantified list):
 * const provider = pintToken(() => currentPint?.token, {
 *   appliesTo: (operationKey) => !operationKey.includes('/webhooks/'),
 * });
 */
export function pintToken(tokenOrGetter: TokenOrGetter, options?: ProviderOptions): AuthProvider {
  return {
    header: 'x-sumvin-pint-token',
    getToken: () => resolve(tokenOrGetter),
    appliesTo: options?.appliesTo,
  };
}
