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
    in apps/web/src/lib/terminal.ts with dynamic window.location.origin resolution,
    and normalizes skill names in formatSkillCommand (e.g. auto_apply -> auto-apply).
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

    if '`${window.location.origin}/terminal`' not in src:
        if not pattern.search(src):
            raise RuntimeError(
                "Could not locate expected TERMINAL_HTTP_URL / TERMINAL_WS_URL block in apps/web/src/lib/terminal.ts."
            )
        src = pattern.sub(replacement, src, count=1)

    # Ensure skill names like auto_apply are normalized to auto-apply in formatSkillCommand
    target_cmd = 'const command = provider === "codex" ? `$${skill}` : `/jobpilot:${skill}`;'
    skill_cmd_replacement = (
        'const normalizedSkill = skill.replace(/_/g, "-");\n'
        '  const command = provider === "codex" ? `$${normalizedSkill}` : `/jobpilot:${normalizedSkill}`;'
    )
    if 'normalizedSkill' not in src:
        if target_cmd in src:
            src = src.replace(target_cmd, skill_cmd_replacement, 1)
        else:
            raise RuntimeError("Could not locate expected formatSkillCommand line in apps/web/src/lib/terminal.ts.")

    return src


def patch_composer_source(src: str) -> str:
    """
    Normalizes campaign mode 'auto_apply' to 'auto-apply' when injecting skill from campaign-composer.tsx.
    """
    target = 'upwork ? "upwork-search" : effective.mode,'
    replacement = 'upwork ? "upwork-search" : (effective.mode === "auto_apply" ? "auto-apply" : effective.mode),'
    if replacement in src:
        return src
    if target not in src:
        raise RuntimeError("Could not locate expected injectSkill mode argument in campaign-composer.tsx.")
    return src.replace(target, replacement, 1)


def apply_patches(app_root: str = "/app", dry_run: bool = False) -> None:
    """
    Applies the dynamic origin patches and skill normalization to apps/web,
    or validates against the pinned upstream commit when dry_run=True.
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
        u_term = f"https://raw.githubusercontent.com/suxrobGM/jobpilot/{PINNED_JOBPILOT_COMMIT}/apps/web/src/lib/terminal.ts"
        req = urllib.request.Request(u_term, headers={"User-Agent": "Mozilla/5.0"})
        src_term = (
            urllib.request.urlopen(req, timeout=10)
            .read()
            .decode("utf-8")
            .replace("\r\n", "\n")
        )
        patched_term = patch_terminal_source(src_term)
        assert "`${window.location.origin}/terminal`" in patched_term
        assert "normalizedSkill" in patched_term

        u_comp = f"https://raw.githubusercontent.com/suxrobGM/jobpilot/{PINNED_JOBPILOT_COMMIT}/apps/web/src/components/features/campaigns/composer/campaign-composer.tsx"
        req2 = urllib.request.Request(u_comp, headers={"User-Agent": "Mozilla/5.0"})
        src_comp = (
            urllib.request.urlopen(req2, timeout=10)
            .read()
            .decode("utf-8")
            .replace("\r\n", "\n")
        )
        patched_comp = patch_composer_source(src_comp)
        assert "auto-apply" in patched_comp

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

    composer_path = f"{app_root}/apps/web/src/components/features/campaigns/composer/campaign-composer.tsx"
    with open(composer_path, "r", encoding="utf-8") as f:
        src_comp = f.read().replace("\r\n", "\n")

    patched_c = patch_composer_source(src_comp)
    with open(composer_path, "w", encoding="utf-8") as f:
        f.write(patched_c)

    print("Successfully patched base-url.ts, terminal.ts, and campaign-composer.tsx for dynamic origin & skill normalization.")


if __name__ == "__main__":
    apply_patches(dry_run=("--dry-run" in sys.argv))
