#!/usr/bin/env python3
"""check-surface-registry.py — CI guard for .claude/surfaces.yml.

Enforces the guards the schema recommends once a registry is live
(.claude/skills/posture-check/references/surface-registry-format.md,
"CI guards"), so the registry can't silently rot the way it did before this
check existed (27 of 43 files in this PR's own diff matched no surface, and
every surface's `class_taxonomy` pointed at a path this repo can never
commit — see ENG-3424). A posture-check mutation pass (this PR) found the
original two guards catch a *dead* glob but pass cleanly through four other
ways the registry can under-check while still printing "OK" — see FIX 5
below; each is now its own check.

  1. Every `paths:` glob resolves to >=1 git-tracked file. A glob matching
     nothing means the file moved (registry rot) or the glob is wrong.
     HARD FAILS (exit 1).
  1a. Every surface parses at least one path at all (FIX 5). A `paths:` list
      that is empty, missing, or whose items are indented outside this
      parser's documented 2-space-per-level subset all collapse to the same
      observable shape — zero globs parsed — and guard 1 above has nothing
      to iterate over in that case, so it reports success having checked
      nothing. This guard can't (and doesn't need to) tell those causes
      apart; zero parsed paths is invalid either way. HARD FAILS (exit 1).
  1b. Every surface key matches `^[a-z0-9-]+:$` (FIX 5). A key outside that
      shape (wrong case, an underscore, …) doesn't match the schema's naming
      rule, so the original parser silently dropped it and every path under
      it — the surface, and its glob coverage, simply vanished from the
      count with no warning. HARD FAILS (exit 1).
  2. Every `class_taxonomy:` file exists on disk — including the case where
     the key is absent entirely (FIX 5): the schema's default
     (`thoughts/vocabulary/<surface>.md`) can never be committed in this
     repo (`thoughts/` is gitignored — see surfaces.yml's own module
     comment), so an absent key is not "use the default," it is the same
     silent demotion-to-universal-core-only a named-but-missing file causes.
     HARD FAILS (exit 1): every registered surface now has a committed
     addendum (`auth`, `hal-origin-guard`, `validation`, `signing` — FIX 6),
     so WARN_ONLY_ON_MISSING_TAXONOMY below is off, matching the schema's
     literal recommendation. Flip it back on only if a surface is
     deliberately registered ahead of its addendum again.

The success line names what it actually checked — surface count AND total
glob count (FIX 5) — so a registry that passed by checking nothing is
visible in the output, not just in the exit code.

Deliberately NOT a general YAML parser: this only reads the two fields this
guard needs (`paths:` sequences, `class_taxonomy:` scalars) out of the
documented supported subset (see surface-registry-format.md). The full
subset parser + glob engine that actually DRIVES posture-check at prompt
time lives in socrates-core/scripts/surface_match.py, outside this repo —
this guard is intentionally self-contained (stdlib-only, no path outside
this repo) so it runs the same in CI as anywhere else.

Usage: python3 .claude/scripts/check-surface-registry.py
"""

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY = REPO_ROOT / ".claude" / "surfaces.yml"

# Flip back to True only if a surface is deliberately registered ahead of a
# committed class_taxonomy addendum again — every surface has one today
# (auth, hal-origin-guard, validation, signing), so this is now a hard
# failure, matching the schema's literal recommendation (FIX 6).
WARN_ONLY_ON_MISSING_TAXONOMY = False


def glob_to_regex(pattern: str) -> str:
    """Mirrors surface_match.py's glob_to_regex: `*` within a segment, `**`
    crosses `/`, `?` single char. No brace-alternation support here — none
    of this registry's globs use it, and adding it would be untested
    generality (six-month-maintenance-test)."""
    out = ""
    i, n = 0, len(pattern)
    while i < n:
        ch = pattern[i]
        if pattern.startswith("**", i):
            if i + 2 < n and pattern[i + 2] == "/":
                out += r"(?:[^/]+/)*"
                i += 3
                continue
            out += r".*"
            i += 2
            continue
        if ch == "*":
            out += r"[^/]*"
        elif ch == "?":
            out += r"[^/]"
        else:
            out += re.escape(ch)
        i += 1
    return out


def parse_surfaces(text: str) -> tuple[dict[str, dict], list[str]]:
    """Extracts {surface_name: {"paths": [...], "class_taxonomy": str|None}}
    from the `surfaces:` mapping, plus a list of parse-level errors (FIX 5).
    Assumes the file is already within the documented supported subset
    (2-space nested indentation, `- ` sequence items, `key: value` scalars,
    `key: |` block scalars) — a file outside that subset is a
    `posture-check` skill concern, not this guard's, EXCEPT for the one
    shape this function actively rejects rather than silently mis-parsing:
    a surface key at indent 2 that does not match `^[a-z0-9-]+:$`. The
    original version matched that regex only on success and fell through to
    "skip this line" on failure — which for THIS specific line meant the
    surface, and every path nested under it, never entered `surfaces` at
    all, with nothing to say why. Recorded as a parse error instead, and
    `current_surface` is reset to `None` so the malformed block's nested
    lines are dropped rather than silently re-attributed to whichever
    surface happened to parse immediately before it."""
    lines = text.split("\n")
    surfaces: dict[str, dict] = {}
    parse_errors: list[str] = []
    current_surface: str | None = None
    in_paths = False
    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.split("#", 1)[0].rstrip()
        if not stripped.strip():
            i += 1
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        content = stripped.strip()

        if indent == 2:
            if re.match(r"^[a-z0-9-]+:\s*$", content):
                current_surface = content[:-1]
                surfaces[current_surface] = {"paths": [], "class_taxonomy": None}
                in_paths = False
            else:
                parse_errors.append(
                    f"malformed surface key {content!r} (line {i + 1}) — surface names must "
                    "match ^[a-z0-9-]+:$ (lowercase letters, digits, hyphens)"
                )
                current_surface = None
                in_paths = False
            i += 1
            continue

        if current_surface is None:
            i += 1
            continue

        if indent == 4 and content == "paths:":
            in_paths = True
            i += 1
            continue

        if in_paths and indent == 6 and content.startswith("- "):
            surfaces[current_surface]["paths"].append(content[2:].strip())
            i += 1
            continue

        if indent == 4 and content.startswith("class_taxonomy:"):
            in_paths = False
            value = content[len("class_taxonomy:") :].strip()
            surfaces[current_surface]["class_taxonomy"] = value.strip("'\"")
            i += 1
            continue

        if indent == 4:
            in_paths = False

        i += 1

    return surfaces, parse_errors


def tracked_files() -> list[str]:
    proc = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [ln for ln in proc.stdout.splitlines() if ln.strip()]


def main() -> int:
    if not REGISTRY.is_file():
        print(f"check-surface-registry: no registry at {REGISTRY} — nothing to check")
        return 0

    surfaces, parse_errors = parse_surfaces(REGISTRY.read_text())
    if not surfaces and not parse_errors:
        print(f"check-surface-registry: {REGISTRY} has no surfaces — treat as REGISTRY_INVALID")
        return 1

    files = tracked_files()
    # Guard 1b (hard fail): a surface key the parser rejected outright — see
    # parse_surfaces's own docstring for why this can't be folded into the
    # per-surface loop below (the surface never made it into `surfaces`).
    errors: list[str] = list(parse_errors)
    warnings: list[str] = []
    total_globs = 0

    for name, spec in surfaces.items():
        # Guard 1a (hard fail): `paths:` parsed at least one entry. Zero
        # entries is indistinguishable, from here, between an empty/missing
        # `paths:` list (invalid per the schema — "comment the surface out
        # instead") and list items indented outside the documented
        # 2-space-per-level subset (an 8-space item under a 4-space
        # `paths:` parses as nothing) — both mean guard 1 below has nothing
        # to iterate over, which is exactly the "OK, 0 globs checked"
        # vacuous pass this guard exists to close.
        if not spec["paths"]:
            errors.append(
                f"surface '{name}': 0 paths parsed — either `paths:` is empty or missing "
                "(invalid; comment the surface out instead) or its list items are indented "
                "outside the documented 2-space-per-level YAML subset (see "
                "surface-registry-format.md, 'Supported YAML subset')"
            )
            continue

        # Guard 1 (hard fail): every glob resolves to >=1 tracked file.
        for pattern in spec["paths"]:
            total_globs += 1
            regex = re.compile(glob_to_regex(pattern))
            if not any(regex.fullmatch(f) for f in files):
                errors.append(
                    f"surface '{name}': glob '{pattern}' matches 0 tracked files "
                    "(registry rot — the file moved, or the glob is wrong)"
                )

        # Guard 2 (warn only if WARN_ONLY_ON_MISSING_TAXONOMY is flipped
        # back on): class_taxonomy is declared AND the file it names
        # exists. An absent key is treated the same as a named-but-missing
        # file — see this module's docstring for why the schema's default
        # path can never rescue it in this repo.
        taxonomy = spec["class_taxonomy"]
        if taxonomy is None:
            msg = (
                f"surface '{name}': no class_taxonomy declared — the schema's default "
                f"(thoughts/vocabulary/{name}.md) can never be committed in this repo, "
                "which silently demotes it to universal-core-only at runtime"
            )
        elif not (REPO_ROOT / taxonomy).is_file():
            msg = (
                f"surface '{name}': class_taxonomy '{taxonomy}' does not exist — "
                "this surface is demoted to universal-core-only at runtime"
            )
        else:
            msg = None
        if msg is not None:
            if WARN_ONLY_ON_MISSING_TAXONOMY:
                warnings.append(msg)
            else:
                errors.append(msg)

    for w in warnings:
        print(f"WARN: {w}")

    if errors:
        for e in errors:
            print(f"FAIL: {e}", file=sys.stderr)
        return 1

    print(
        f"check-surface-registry: OK — {len(surfaces)} surface(s), {total_globs} glob(s), "
        "all resolve"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
