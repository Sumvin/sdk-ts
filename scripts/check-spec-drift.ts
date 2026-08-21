import { readFileSync } from 'node:fs';
import {
  classifyDrift,
  fetchLatestSpecCommitSha,
  fetchSpecAtSha,
  normalizeWithJq,
  readPin,
  SPEC_TARGET_PATH,
} from './lib/spec-source';

// UPSTREAM drift, which is a different question from `spec:check` freshness and
// is why both exist:
//
//   spec:check  -- does spec/openapi.json match what the PINNED SHA holds?
//                  Pinned content is immutable, so this is deterministic and
//                  safe as a required PR status check. It can never notice that
//                  upstream has moved on.
//   spec:drift  -- has sumvin-api's spec MOVED since we pinned it? Reads live
//                  upstream state, so its answer changes under you. Scheduled
//                  and manual only; never a required check on a PR.
//
// Before this script existed the Monday cron ran spec:check and its comment
// claimed it "catches upstream drift" -- it structurally could not. This is the
// job that actually can.

function main(): void {
  const pinnedSha = readPin();
  const upstreamSha = fetchLatestSpecCommitSha();
  const committed = readFileSync(SPEC_TARGET_PATH);
  const upstream = normalizeWithJq(fetchSpecAtSha(upstreamSha));

  const verdict = classifyDrift({
    pinnedSha,
    upstreamSha,
    contentMatches: upstream.equals(committed),
  });

  if (verdict === 'in-sync') {
    console.info(`spec/PIN is current: ${pinnedSha} is the latest commit touching the spec.`);
    return;
  }

  if (verdict === 'pin-behind-content-identical') {
    console.info(
      `spec/PIN (${pinnedSha}) is behind upstream (${upstreamSha}), but the spec content is` +
        ' byte-identical. No regeneration needed; re-pinning is a free no-op.',
    );
    return;
  }

  console.error(`spec/openapi.json has DRIFTED from upstream sumvin-api.`);
  console.error(`  pinned:   ${pinnedSha}`);
  console.error(`  upstream: ${upstreamSha}`);
  console.error('');
  console.error('Re-pin and regenerate:');
  console.error(`  echo ${upstreamSha} > spec/PIN`);
  console.error('  bun run spec:pull');
  console.error(
    '  bun run spec:diff-security   # read the security-scheme diff before trusting it',
  );
  console.error('  bun run generate');
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error('spec:drift failed:', (error as Error).message);
  process.exit(1);
}
