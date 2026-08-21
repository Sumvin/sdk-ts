import { readFileSync } from 'node:fs';
import { fetchSpecAtSha, normalizeWithJq, readPin, SPEC_TARGET_PATH } from './lib/spec-source';

function main(): void {
  const sha = readPin();
  const raw = fetchSpecAtSha(sha);
  // Apply the IDENTICAL normalisation pull-spec.ts applies before comparing.
  // A raw fetch compared against a normalised vendored file fails every time:
  // the raw payload is 1,333,669 bytes with 2,210 `\u` escapes; jq decodes
  // them to real UTF-8 at 1,327,037 bytes. Semantically equal, textually
  // different. Both sides normalise, or neither does -- normalizeWithJq is
  // imported from the same module pull-spec.ts uses, not re-implemented here.
  const fresh = normalizeWithJq(raw);
  const committed = readFileSync(SPEC_TARGET_PATH);

  if (!fresh.equals(committed)) {
    console.error(`spec/openapi.json is STALE relative to pinned SHA ${sha}.`);
    console.error('Run "bun run spec:pull" and commit the result.');
    process.exit(1);
  }
  console.info(`spec/openapi.json matches pinned SHA ${sha}.`);
}

try {
  main();
} catch (error) {
  console.error('spec:check failed:', (error as Error).message);
  process.exit(1);
}
