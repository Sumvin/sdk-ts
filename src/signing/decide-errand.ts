import type { Client } from '../generated/client/index.js';
import { approveIpa } from '../generated/sdk.gen.js';
import type { ApproveIpaError, Eip712Payload, IpaDetailResponse } from '../generated/types.gen.js';
import { coerceTypedDataIntegers } from './coerce.js';
import type { SignTypedDataFn } from './types.js';

/**
 * Decide an errand awaiting a purchase approval. `decision: 'approved'`
 * requires `approvalPayload` (read from `IpaData.approval_payload`) and a
 * {@link SignTypedDataFn} — the type makes an unsigned approval a compile
 * error, mirroring the server's own refusal
 * (`ApproveIpaErrors[401]` — "No signature was supplied"). `'rejected'` and
 * `'conditional'` carry no signature; the server accepts `ApprovalDecision`
 * generally, so both are representable here even though only `'approved'`
 * needs a signing seam.
 */
export type DecideErrandParams = { client: Client; ipaId: string } & (
  | {
      decision: 'approved';
      /** `IpaData.approval_payload` from a PENDING errand. Read it, don't construct it — it's server-prepared. */
      approvalPayload: Eip712Payload;
      /** The injected signing seam — see `SignTypedDataFn`. */
      signTypedData: SignTypedDataFn;
    }
  | { decision: 'rejected' | 'conditional' }
);

export type DecideErrandResult =
  | { data: IpaDetailResponse; error: undefined; request?: Request; response?: Response }
  | { data: undefined; error: ApproveIpaError; request?: Request; response?: Response };

/**
 * Read-coerce-sign-PUT: for `'approved'`, coerce `approvalPayload`'s
 * integer-typed fields to BigInt via {@link coerceTypedDataIntegers}, sign
 * it, and `PUT` the decision at `/v0/user/ipa/{ipa_id}/decision`
 * (`approveIpa`). For `'rejected'`/`'conditional'`, no signature is sent —
 * the server accepts a decision with `signature` omitted for anything other
 * than an approval.
 *
 * @example
 * const decided = await decideErrand({
 *   client,
 *   ipaId,
 *   decision: 'approved',
 *   approvalPayload: ipa.approval_payload!,
 *   signTypedData: (typedData) => wallet.signTypedData({ account, ...typedData }),
 * });
 *
 * @example
 * const declined = await decideErrand({ client, ipaId, decision: 'rejected' });
 */
export async function decideErrand(params: DecideErrandParams): Promise<DecideErrandResult> {
  const { client, ipaId } = params;

  if (params.decision === 'approved') {
    const typedData = coerceTypedDataIntegers(params.approvalPayload);
    const signature = await params.signTypedData(typedData);
    return approveIpa({
      client,
      path: { ipa_id: ipaId },
      body: { decision: 'approved', signature },
    });
  }

  return approveIpa({
    client,
    path: { ipa_id: ipaId },
    body: { decision: params.decision },
  });
}
