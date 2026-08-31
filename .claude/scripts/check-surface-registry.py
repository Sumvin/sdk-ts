#!/usr/bin/env python3
"""check-surface-registry.py — CI guard for .claude/surfaces.yml.

Enforces the two guards the schema recommends once a registry is live
(.claude/skills/posture-check/references/surface-registry-format.md,
"CI guards"), so the registry can't silently rot the way it did before this
check existed (27 of 43 files in this PR's own diff matched no surface, and
every surface's `class_taxonomy` pointed at a path this repo can never
commit — see ENG-3424).

  1. Every `paths:` glob resolves to >=1 git-tracked file. A glob matching
     nothing means the file moved (registry rot) or the glob is wrong.
     HARD FAILS (exit 1).
  2. Every `class_taxonomy:` file exists on disk. A missing file silently
     demotes a surface to universal-core-only at runtime (the skill warns,
     but nothing before this made it a build failure).
     WARNS ONLY (exit 0) for now: `validation` and `signing` deliberately
     ship without an addendum yet (ENG-3424 authored `auth` and
     `hal-origin-guard` first — see the surfaces.yml description for why
     those two). Once every registered surface has a committed addendum,
     flip WARN_ONLY_ON_MISSING_TAXONOMY to False below to make this a hard
     failure too, matching the schema's literal recommendation.

Deliberately NOT a general YAML parser: this only reads the two fields this
guard needs (`paths:` sequences, `class_taxonomy:` scalars) out of the
documented supported subset (see surface-registry-format.md). The full
subset parser + glob engine that actually DRIVES posture-check at prompt
time lives in socrates-core/scripts/surface_match.py, outside this repo —
this guard is intentionally self-contained (stdlib-only, no path outside
this repo) so it runs the same in CI as anywhere else.

Usage: python3 .claude/scripts/check-surface-registry.py
"""

import fnmatch
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY = REPO_ROOT / ".claude" / "surfaces.yml"

# Flip to False once every registered surface has a committed class_taxonomy
# file (today: `validation` and `signing` deliberately don't yet).
WARN_ONLY_ON_MISSING_TAXONOMY = True


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


def parse_surfaces(text: str) -> dict[str, dict]:
    """Extracts {surface_name: {"paths": [...], "class_taxonomy": str|None}}
    from the `surfaces:` mapping. Assumes the file is already within the
    documented supported subset (2-space nested indentation, `- ` sequence
    items, `key: value` scalars, `key: |` block scalars) — a file outside
    that subset is a `posture-check` skill concern, not this guard's."""
    lines = text.split("\n")
    surfaces: dict[str, dict] = {}
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

        if indent == 2 and re.match(r"^[a-z0-9-]+:\s*$", content):
            current_surface = content[:-1]
            surfaces[current_surface] = {"paths": [], "class_taxonomy": None}
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

    return surfaces


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

    surfaces = parse_surfaces(REGISTRY.read_text())
    if not surfaces:
        print(f"check-surface-registry: {REGISTRY} has no surfaces — treat as REGISTRY_INVALID")
        return 1

    files = tracked_files()
    errors: list[str] = []
    warnings: list[str] = []

    for name, spec in surfaces.items():
        # Guard 1 (hard fail): every glob resolves to >=1 tracked file.
        for pattern in spec["paths"]:
            regex = re.compile(glob_to_regex(pattern))
            if not any(regex.fullmatch(f) for f in files):
                errors.append(
                    f"surface '{name}': glob '{pattern}' matches 0 tracked files "
                    "(registry rot — the file moved, or the glob is wrong)"
                )

        # Guard 2 (warn today; hard fail once WARN_ONLY_ON_MISSING_TAXONOMY
        # is flipped off): class_taxonomy file exists.
        taxonomy = spec["class_taxonomy"]
        if taxonomy and not (REPO_ROOT / taxonomy).is_file():
            msg = (
                f"surface '{name}': class_taxonomy '{taxonomy}' does not exist — "
                "this surface is demoted to universal-core-only at runtime"
            )
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

    print(f"check-surface-registry: OK — {len(surfaces)} surface(s), all globs resolve")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
