/**
 * Names the 202-vs-208 idempotency-replay outcome off `response.status`
 * (P6). `POST /v0/user/ipa/` (`createIpa`) declares both statuses with an
 * identical `IPADetailResponse` body — the generated client already returns
 * `response` alongside `data`, so the status was never discarded, and this
 * function is the only extra step needed. It obviates sumvin-cli's
 * `POSTWithStatus` hack (`cli/src/runtime/client.ts:111,156`), which existed
 * only because that client's ordinary verbs erase the status entirely.
 *
 * `undefined` covers every other status — a plain success, or an error
 * result — so a caller can safely call this on any result without first
 * checking whether the operation was actually a replay-capable one.
 *
 * @example
 * const result = await createIpa({ client, body });
 * switch (replayOutcome(result)) {
 *   case 'created':
 *     notifyUser('Purchase request submitted.');
 *     break;
 *   case 'replayed':
 *     notifyUser('Already submitted — showing the existing request.');
 *     break;
 * }
 */
export function replayOutcome(result: { response?: Response }): 'created' | 'replayed' | undefined {
  switch (result.response?.status) {
    case 202:
      return 'created';
    case 208:
      return 'replayed';
    default:
      return undefined;
  }
}
