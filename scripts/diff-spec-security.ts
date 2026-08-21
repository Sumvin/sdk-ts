import { readFileSync } from 'node:fs';
import type { OpenApiSpecLike } from './lib/security-diff';
import { computeSecurityDiff, formatSecurityDiff, hasChanges } from './lib/security-diff';

function loadSpec(path: string): OpenApiSpecLike {
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiSpecLike;
}

function main(): void {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error('Usage: diff-spec-security.ts <old-spec.json> <new-spec.json>');
    process.exit(2);
  }
  const diff = computeSecurityDiff(loadSpec(oldPath), loadSpec(newPath));
  console.log(formatSecurityDiff(diff));
  process.exit(hasChanges(diff) ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error('spec:diff-security failed:', (error as Error).message);
  process.exit(2);
}
