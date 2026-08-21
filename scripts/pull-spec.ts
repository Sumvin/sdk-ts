import {
  fetchSpecAtSha,
  normalizeWithJq,
  PIN_PATH,
  readPin,
  SPEC_TARGET_PATH,
  writeAtomic,
} from './lib/spec-source';

function main(): void {
  const sha = readPin();
  console.info(`Fetching spec at ${sha} (pinned in ${PIN_PATH})...`);
  const raw = fetchSpecAtSha(sha);
  const normalized = normalizeWithJq(raw);
  writeAtomic(SPEC_TARGET_PATH, normalized);
  console.info(`Wrote ${normalized.byteLength} bytes to ${SPEC_TARGET_PATH}`);
}

try {
  main();
} catch (error) {
  console.error('spec:pull failed:', (error as Error).message);
  process.exit(1);
}
