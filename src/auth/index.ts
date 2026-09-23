/**
 * `@sumvin/sdk` auth — credential providers and the device-authorization
 * sign-in flow.
 *
 * {@link installAuthInterceptor} registers a `client.interceptors.request`
 * handler that sets every configured {@link AuthProvider}'s header,
 * additively — deliberately not through `Config.auth` / per-operation
 * `security` metadata; see `./interceptor.js` for why.
 * {@link junoJwt}, {@link sumvinPat}, and {@link pintToken} are the three
 * providers this SDK ships. {@link deviceLogin} drives the CLI sign-in flow
 * end to end: create, poll (with `retry-after`-aware backoff), exchange.
 */
export {
  DeviceLoginConflictError,
  DeviceLoginError,
  DeviceLoginExpiredError,
  DeviceLoginNotFoundError,
  type DeviceLoginOptions,
  DeviceLoginTimeoutError,
  type DeviceLoginUserCode,
  deviceLogin,
} from './device.js';
export { installAuthInterceptor } from './interceptor.js';
export {
  type AuthProvider,
  type Awaitable,
  junoJwt,
  pintToken,
  sumvinPat,
  type TokenOrGetter,
} from './provider.js';
