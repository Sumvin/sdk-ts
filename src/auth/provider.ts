/**
 * `AuthProvider` and the three header-scoped credential providers this SDK
 * ships: {@link junoJwt}, {@link sumvinPat}, {@link pintToken}.
 *
 * A provider only *supplies* a token on demand — it never stores one.
 * Storage (a keychain, an env var, an in-memory store, a React context) is
 * the consumer's job; see `./interceptor.js` for how these are installed and
 * why every configured provider that yields a token is applied additively,
 * never through `Config.auth` (D2).
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
 * cover the three schemes the PRD names (`x-sumvin-ucp-token` is declared in
 * the spec but named by no consumer — P10 — so it has no factory here).
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
}

/**
 * A static string, or a getter that supplies one (sync or async). Accepted
 * by {@link sumvinPat} and {@link pintToken} — {@link junoJwt} deliberately
 * does not accept a static string; see its TSDoc for why.
 */
export type TokenOrGetter = string | (() => Awaitable<string | undefined>);

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
export function junoJwt(getter: () => Awaitable<string | undefined>): AuthProvider {
  return {
    header: 'x-juno-jwt',
    getToken: () => getter(),
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
export function sumvinPat(tokenOrGetter: TokenOrGetter): AuthProvider {
  return {
    header: 'x-sumvin-pat',
    getToken: () => resolve(tokenOrGetter),
  };
}

/**
 * `x-sumvin-pint-token` provider — an agent's scoped purchase-intent token.
 *
 * Set **alongside**, never instead of, a base-credential provider
 * ({@link junoJwt} or {@link sumvinPat}) — see `./interceptor.js` for why
 * (D2 / ENG-3386): the server resolves a caller from a base credential
 * unconditionally before it ever reads a PINT header, so swapping one
 * scheme for another per operation (the way `Config.auth` would) can
 * silently drop whichever header the server's per-operation `security`
 * metadata didn't select.
 *
 * @example
 * const client = createSumvinClient({
 *   baseUrl,
 *   auth: [sumvinPat(pat), pintToken(() => currentPint?.token)],
 * });
 */
export function pintToken(tokenOrGetter: TokenOrGetter): AuthProvider {
  return {
    header: 'x-sumvin-pint-token',
    getToken: () => resolve(tokenOrGetter),
  };
}
