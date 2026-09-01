/**
 * Proves things about the PUBLISHED ARTIFACT that no other gate can see.
 *
 * `bun run build` succeeding says nothing about what lands in the tarball, whether a
 * consumer can resolve the subpaths, or whether a Node builtin crept into a chunk. Those
 * are properties of the packed-and-installed package, so they need the package packed and
 * installed. Adversarial verification found a 167KB `node_modules` directory
 * shipping inside `dist/` that every source-level gate was blind to.
 *
 * Run after `bun run build`. Exits non-zero on the first failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.info(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const run = (cmd: string, args: string[], cwd?: string): string =>
  execFileSync(cmd, args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

// ---------------------------------------------------------------- pack
console.info('\n1. Tarball contents');
const packed = JSON.parse(run('npm', ['pack', '--dry-run', '--json']))[0] as {
  files: { path: string }[];
  entryCount: number;
};
const paths = packed.files.map((f) => f.path);

// A `node_modules` inside a published package shadows resolution for anything resolving
// out of that directory, and pins the consumer's transitive *types* to our build.
const nested = paths.filter((p) => p.includes('node_modules/'));
check('no nested node_modules in the tarball', nested.length === 0, nested.slice(0, 3).join(', '));

for (const required of ['package.json', 'README.md', 'LICENSE']) {
  check(`tarball contains ${required}`, paths.includes(required));
}
// Planning artifacts, evidence, and the vendored spec are not consumer surface.
const leaked = paths.filter((p) => /^(thoughts|spec|scripts|src)\//.test(p));
check('tarball ships only dist + metadata', leaked.length === 0, leaked.slice(0, 3).join(', '));

// ---------------------------------------------------------------- edge safety
console.info('\n2. Edge safety — no Node builtins in any emitted chunk');
const BUILTINS =
  'fs|path|crypto|http|https|os|child_process|net|tls|stream|zlib|worker_threads|url|util';
// Both quote styles, bare AND node:-prefixed, static import AND require AND dynamic
// import AND re-export. A pattern that only catches require('fs') is decoration.
const BUILTIN_RE = new RegExp(
  `(?:require|import)\\s*\\(?\\s*["'](?:node:)?(?:${BUILTINS})["']|from\\s+["'](?:node:)?(?:${BUILTINS})["']`,
);
let scanned = 0;
const offenders: string[] = [];
for (const p of paths.filter((f) => /^dist\/.*\.(js|cjs|mjs)$/.test(f))) {
  scanned += 1;
  if (BUILTIN_RE.test(run('cat', [p]))) offenders.push(p);
}
check(
  `no Node builtin imported in any of ${scanned} emitted chunks`,
  offenders.length === 0,
  offenders.join(', '),
);

// The gate must be able to fail. Prove it every run rather than trusting it.
const probes = [
  "require('fs')",
  'require("fs")',
  "import x from 'fs'",
  "require('node:fs')",
  "await import('crypto')",
  "export * from 'worker_threads'",
];
const missed = probes.filter((p) => !BUILTIN_RE.test(p));
check('the builtin pattern catches all 6 probe forms', missed.length === 0, missed.join(' | '));

// ---------------------------------------------------------------- resolution
console.info('\n3. Subpath resolution from an INSTALLED context');
// `require.resolve` on a filesystem path never consults the `exports` map. Only a bare
// specifier resolved from inside node_modules tests what the exports map actually does.
const root = mkdtempSync(join(tmpdir(), 'sumvin-sdk-verify-'));
try {
  const tgz = run('npm', ['pack', '--pack-destination', root]).trim().split('\n').pop() as string;
  const app = join(root, 'app');
  mkdirSync(join(app, 'node_modules', '@sumvin'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"verify","private":true,"version":"1.0.0"}\n');
  // Order matters: `npm install` rewrites node_modules and would evict a
  // hand-placed package, so install the real dependency FIRST and drop the
  // package in afterwards.
  run('npm', ['install', 'zod@^4', '--silent', '--no-audit', '--no-fund'], app);
  run('tar', ['-xzf', join(root, tgz), '-C', root]);
  mkdirSync(join(app, 'node_modules', '@sumvin'), { recursive: true });
  renameSync(join(root, 'package'), join(app, 'node_modules', '@sumvin', 'sdk'));

  const specifiers = [
    '@sumvin/sdk',
    '@sumvin/sdk/signing',
    '@sumvin/sdk/testing',
    '@sumvin/sdk/package.json',
    '@sumvin/sdk/generated/core/types.gen',
  ];
  for (const s of specifiers) {
    let ok = true;
    let detail = '';
    try {
      run('node', ['-e', `require.resolve(${JSON.stringify(s)})`], app);
    } catch (e) {
      ok = false;
      detail = (e as Error).message.split('\n')[0];
    }
    check(`bare specifier resolves: ${s}`, ok, detail);
  }
  // Load it for real, in both module systems and under Bun.
  const loaders: [string, string[]][] = [
    ['node', ['-e', "const m=require('@sumvin/sdk'); if(!Object.keys(m).length) process.exit(1)"]],
    [
      'node',
      [
        '--input-type=module',
        '-e',
        "const m=await import('@sumvin/sdk'); if(!Object.keys(m).length) process.exit(1)",
      ],
    ],
    [
      'bun',
      ['-e', "const m=await import('@sumvin/sdk'); if(!Object.keys(m).length) process.exit(1)"],
    ],
  ];
  for (const [bin, args] of loaders) {
    let ok = true;
    try {
      run(bin, args, app);
    } catch {
      ok = false;
    }
    check(`@sumvin/sdk loads under ${bin}${args[0] === '--input-type=module' ? ' (ESM)' : ''}`, ok);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.info(
  failures === 0 ? '\nPackage verification passed.\n' : `\n${failures} package check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
