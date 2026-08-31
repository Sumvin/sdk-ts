# Pattern vocabulary addendum — `hal-origin-guard` surface

Prefix: `H`. Seeded from ENG-3424 (the curated layer), reproduced/fixed
directly in this repo's history — not hypotheticals. See
`.claude/surfaces.yml` for the surface's registered paths and
`.claude/skills/posture-check/references/surface-registry-format.md` for
this file's role. Per-class format follows
`socrates-core/reference/universal-classes.md`.

## H1 — An origin/scheme allow-list check is a raw-string prefix test,
defeated by input the URL parser would normalize first

**Shape:** `href.startsWith('//')` (or any raw prefix/substring test used as
a security decision on an untrusted URL-shaped string) instead of comparing
what the string would resolve to once run through the actual URL parser
that will later consume it.

**Why it kills:** the WHATWG URL parser — the same parser `fetch`/`new
Request` uses — trims leading C0 controls and space, removes ASCII
tab/CR/LF from *anywhere* in the string (not just the ends), and treats `\`
as `/` before it ever looks at path structure. A raw `startsWith('//')`
walks straight past every one of these spellings: `" //evil.com/x"`,
`"\t//evil.com/x"`, and `"/\\evil.com/x"` all resolve to a different host
under `new URL(href, base)` while none of them starts with the literal
two-character prefix `"//"`. The check passes (looks like a safe relative
href), the request proceeds, and it lands on a different host than the one
being reasoned about — an SSRF-shaped request, credentialed if the guard's
whole purpose was gating credentialed follows.

**Concrete fingerprint (fixed in this repo — `src/hal/origin-guard.ts`):**
```ts
// VULNERABLE shape: raw prefix test
function isProtocolRelative(href: string): boolean {
  return href.startsWith('//');
}

// FIXED shape this surface protects: normalize the way the URL parser
// would BEFORE checking, so the refusal is keyed on what the string would
// BECOME, not its literal first two bytes.
function normalizesToProtocolRelative(href: string): boolean {
  const normalized = href
    .replace(/^[\x00-\x20]+/, '')
    .replace(/[\t\n\r]/g, '')
    .replace(/\\/g, '/');
  return normalized.startsWith('//');
}
```

**Where it usually lives:** any hand-written origin/scheme/host allow-list
or deny-list that string-matches an href, redirect target, or webhook
callback URL before it is later parsed by a real URL implementation
downstream (browser `fetch`, Node `http`, a proxy) that WILL normalize it.

**What "an instance" looks like:** the raw string check + the specific
normalization step it skips (leading-whitespace trim, mid-string
tab/CR/LF removal, backslash-to-slash) + a concrete input that passes the
check today but resolves to a different origin once actually dispatched.

**Typical severity:** Critical — blast is an SSRF-shaped, potentially
credentialed request to an attacker-controlled host; detectability is
silent (the malformed-but-normalizing href looks like an ordinary relative
path to the check, and to a developer reading it); trigger requires only
that an href value the code trusts (a HAL `_links` entry, a redirect
`Location`, a webhook callback) be attacker-influenced, which is exactly
the threat model an origin guard exists for.

**Check mode:** deterministic — grep for a bare `.startsWith('//')` (or
equivalent raw prefix/substring test) gating a security decision on a URL
string, with no normalization step before it.

## H2 — A path-prefix containment claim is checked against the raw
string instead of the collapsed path, so `..` escapes it

**Shape:** code asserts "this path stays under `<prefix>`" (a BFF/reverse-
proxy mount, a tenant-scoped path, a sandboxed directory) by comparing the
*uncollapsed* input string against the prefix — `path.startsWith(prefix)`
— rather than collapsing `.`/`..` segments the way the string will
actually be resolved before that comparison.

**Why it kills:** a relative href/path is typically handed unchanged to
whatever will resolve it — a generated HTTP client's own URL-building
(string concatenation), `fetch`, or a filesystem API — and THAT layer
collapses `..` segments during resolution, not before. If the containment
check runs on the pre-collapse string, `../../evil` against a mount like
`/api/proxy` passes a naive `startsWith('/api/proxy')`-style check (or
simply isn't rejected because the check never modeled `..` at all) and then
resolves, once concatenated and collapsed downstream, to a path entirely
outside the intended mount — a request off the proxy with whatever
ambient credentials/cookies the proxy call carries, at a path the proxy
never routes.

**Concrete fingerprint (fixed in this repo —
`src/hal/origin-guard.ts:describeBaseUrlPrefixEscape`):**
```ts
// VULNERABLE shape: prefix check on the raw, uncollapsed string
function staysUnderMount(href: string, mount: string): boolean {
  return href.startsWith(mount); // '../../evil' never starts with mount,
                                  // but a check like this is easy to get
                                  // wrong in the OTHER direction: comparing
                                  // the CONCATENATED-but-uncollapsed string
                                  // against the mount, which DOES pass.
}

// FIXED shape this surface protects: concatenate exactly as the request
// will actually be built, THEN collapse via a real URL parser, THEN
// compare the collapsed pathname against the mount's own (identically
// parsed) pathname.
const resolvedPath = new URL(`${mount}${pathUrl}`, DUMMY_ORIGIN).pathname;
const basePath = new URL(mount, DUMMY_ORIGIN).pathname;
if (resolvedPath === basePath || resolvedPath.startsWith(`${basePath}/`)) { /* ok */ }
```

**Where it usually lives:** any "stays under this mount/prefix" guard for a
BFF proxy path, a tenant/org-scoped storage prefix, or a sandboxed
filesystem root — anywhere a relative path is trusted to compose with a
base path and only checked before, not after, the composition + collapse
that will actually happen.

**What "an instance" looks like:** the containment check + confirmation it
runs on the collapsed/resolved path (via the same resolution mechanism the
real request/file-access will use), not the raw input string + a concrete
`../`-bearing input that would pass the check as written.

**Typical severity:** High — blast is a request that escapes the intended
mount/prefix, potentially carrying the mount's ambient credentials, to a
path outside the routed proxy surface; detectability is silent (looks like
an ordinary relative-link follow); trigger requires the href/path value to
be attacker-influenced (a compromised or malicious `_links` entry, a
templated variable), a narrower precondition than H1's, which is what
separates the two tiers.

**Check mode:** hybrid — grep finds `startsWith(<mount>)`-shaped
containment checks, but confirming whether the comparison happens before or
after the same collapse the eventual request/file-access performs requires
reading the surrounding resolution logic.

## Summary

| ID | Class | Typical severity | Check mode |
|---|---|---|---|
| H1 | Raw-string prefix test defeated by URL-parser normalization | Critical | deterministic |
| H2 | Path-prefix containment checked pre-collapse, escaped by `..` | High | hybrid |

Citations: ENG-3424 curated-layer PR, `src/hal/origin-guard.ts` — H1 is
"FIX 1" and H2 is "FIX 2" in the module's own TSDoc, both found by two
independent re-verification passes; H1 also cites a protocol-relative-href
regression fixed in commit `5731f24` ("refuse protocol-relative hrefs
instead of relying on the generator").
