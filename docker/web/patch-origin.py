"""
Origin-agnostic build-time patcher for suxrobGM/jobpilot apps/web.
Rewrites API_BASE_URL and TERMINAL_HTTP_URL / TERMINAL_WS_URL to resolve dynamically
from window.location.origin when running in the browser behind the single-origin Nginx proxy.
"""

import re
import sys
import urllib.request

PINNED_JOBPILOT_COMMIT = "08fa978ecac0da68b0ee5694c93c0d94f18b4d9f"


def patch_terminal_source(src: str) -> str:
    """
    Replaces the static NEXT_PUBLIC_TERMINAL_URL and TERMINAL_WS_URL declarations
    in apps/web/src/lib/terminal.ts with dynamic window.location.origin resolution.
    """
    pattern = re.compile(
        r'const\s+TERMINAL_HTTP_URL\s*=\s*process\.env\.NEXT_PUBLIC_TERMINAL_URL\s*\?\?\s*"http://localhost:4102";\s*'
        r'export\s+const\s+TERMINAL_WS_URL\s*=\s*`\$\{TERMINAL_HTTP_URL\.replace\(/\^http/,\s*"ws"\)\}/ws`;',
        re.MULTILINE,
    )

    replacement = (
        'const TERMINAL_HTTP_URL =\n'
        '  typeof window !== "undefined"\n'
        '    ? `${window.location.origin}/terminal`\n'
        '    : (process.env.NEXT_PUBLIC_TERMINAL_URL ?? "http://terminal:4102");\n\n'
        'export const TERMINAL_WS_URL =\n'
        '  typeof window !== "undefined"\n'
        '    ? `${window.location.origin.replace(/^http/, "ws")}/terminal/ws`\n'
        '    : `${TERMINAL_HTTP_URL.replace(/^http/, "ws")}/ws`;'
    )

    if '`${window.location.origin}/terminal`' in src:
        return src

    if not pattern.search(src):
        raise RuntimeError(
            "Could not locate expected TERMINAL_HTTP_URL / TERMINAL_WS_URL block in apps/web/src/lib/terminal.ts."
        )

    return pattern.sub(replacement, src, count=1)


def apply_patches(app_root: str = "/app", dry_run: bool = False) -> None:
    """
    Applies the dynamic origin patches to apps/web/src/api/base-url.ts and
    apps/web/src/lib/terminal.ts, or validates against the pinned upstream commit when dry_run=True.
    """
    base_url_content = """export const API_BASE_URL =
  typeof window !== "undefined"
    ? window.location.origin
    : (process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://api:4101");

export const API_ORIGIN =
  typeof window === "undefined"
    ? (process.env.INTERNAL_API_URL ?? API_BASE_URL)
    : window.location.origin;
"""

    if dry_run:
        u = f"https://raw.githubusercontent.com/suxrobGM/jobpilot/{PINNED_JOBPILOT_COMMIT}/apps/web/src/lib/terminal.ts"
        req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
        src = (
            urllib.request.urlopen(req, timeout=10)
            .read()
            .decode("utf-8")
            .replace("\r\n", "\n")
        )
        patched = patch_terminal_source(src)
        assert "`${window.location.origin}/terminal`" in patched
        print(
            f"Dry-run verified: patch-origin.py matches suxrobGM/jobpilot@{PINNED_JOBPILOT_COMMIT[:8]} 100%."
        )
        return

    base_url_path = f"{app_root}/apps/web/src/api/base-url.ts"
    with open(base_url_path, "w", encoding="utf-8") as f:
        f.write(base_url_content)

    terminal_path = f"{app_root}/apps/web/src/lib/terminal.ts"
    with open(terminal_path, "r", encoding="utf-8") as f:
        src = f.read().replace("\r\n", "\n")

    patched = patch_terminal_source(src)
    with open(terminal_path, "w", encoding="utf-8") as f:
        f.write(patched)

    print("Successfully patched base-url.ts and terminal.ts for dynamic origin resolution.")


if __name__ == "__main__":
    apply_patches(dry_run=("--dry-run" in sys.argv))
