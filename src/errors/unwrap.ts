/**
 * Unwraps a non-throwing `{ data, error }` result — the shape every generated
 * operation returns by default (`throwOnError: false`) — into `data`,
 * throwing `error` when the call failed. For flow code that would rather
 * `try`/`catch` (or let the error propagate) than branch on `error !==
 * undefined` at every call site.
 *
 * Once {@link installErrorInterceptor} is installed, `error` here is always
 * a {@link SumvinError} — but NOT always specifically an {@link ApiError}:
 * on a client that also has response validation installed (the default via
 * `createSumvinClient`), a strict-tier operation's `error` can be a
 * `ContractDriftError` instead, deliberately left un-normalized (see
 * `installErrorInterceptor`'s bypass). Narrow with {@link isSumvinError} in
 * the `catch` to handle either, then `isApiError` / `isContractDriftError`
 * to tell them apart.
 *
 * @example
 * try {
 *   const budget = unwrap(await getBudget({ client, path: { budget_id } }));
 *   console.log(budget.name);
 * } catch (e) {
 *   if (isApiError(e)) console.error(e.kind, e.message);
 *   else if (isContractDriftError(e)) console.error(e.operationKey, e.reason);
 * }
 *
 * @example
 * // Or, unwrapping a promise directly:
 * const budget = await getBudget({ client, path: { budget_id } }).then(unwrap);
 */
export function unwrap<TData, TError = unknown>(result: { data?: TData; error?: TError }): TData {
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.data as TData;
}
