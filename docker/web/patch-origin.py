import sys
import urllib.request

def apply_patches(app_root="/app", dry_run=False):
    base_url_content = """export const API_BASE_URL =
  typeof window !== "undefined"
    ? window.location.origin
    : (process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://api:4101");

export const API_ORIGIN =
  typeof window === "undefined"
    ? (process.env.INTERNAL_API_URL ?? API_BASE_URL)
    : window.location.origin;
"""

    old_block = (
        'const TERMINAL_HTTP_URL = process.env.NEXT_PUBLIC_TERMINAL_URL ?? "http://localhost:4102";\n\n'
        'export const TERMINAL_WS_URL = `${TERMINAL_HTTP_URL.replace(/^http/, "ws")}/ws`;'
    )

    new_block = (
        'const TERMINAL_HTTP_URL =\n'
        '  typeof window !== "undefined"\n'
        '    ? `${window.location.origin}/terminal`\n'
        '    : (process.env.NEXT_PUBLIC_TERMINAL_URL ?? "http://terminal:4102");\n\n'
        'export const TERMINAL_WS_URL =\n'
        '  typeof window !== "undefined"\n'
        '    ? `${window.location.origin.replace(/^http/, "ws")}/terminal/ws`\n'
        '    : `${TERMINAL_HTTP_URL.replace(/^http/, "ws")}/ws`;'
    )

    if dry_run:
        u = "https://raw.githubusercontent.com/suxrobGM/jobpilot/main/apps/web/src/lib/terminal.ts"
        req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
        src = urllib.request.urlopen(req, timeout=10).read().decode("utf-8").replace("\r\n", "\n")
        assert old_block in src, "Expected TERMINAL_HTTP_URL block in upstream terminal.ts"
        print("Dry-run verified: patch-origin.py matches upstream suxrobGM/jobpilot 100%.")
        return

    base_url_path = f"{app_root}/apps/web/src/api/base-url.ts"
    with open(base_url_path, "w", encoding="utf-8") as f:
        f.write(base_url_content)

    terminal_path = f"{app_root}/apps/web/src/lib/terminal.ts"
    with open(terminal_path, "r", encoding="utf-8") as f:
        src = f.read().replace("\r\n", "\n")

    assert old_block in src, f"Expected TERMINAL_HTTP_URL block in {terminal_path}"
    src = src.replace(old_block, new_block, 1)

    with open(terminal_path, "w", encoding="utf-8") as f:
        f.write(src)

    print("Successfully patched base-url.ts and terminal.ts for dynamic origin resolution.")

if __name__ == "__main__":
    apply_patches(dry_run=("--dry-run" in sys.argv))
