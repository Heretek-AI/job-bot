import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const STEALTH_URL = (
  process.env.STEALTH_BROWSER_URL || "http://stealth-browser:8080"
).replace(/\/+$/, "");

interface StealthResponse {
  success?: boolean;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

async function callStealth(
  action: string,
  params: Record<string, unknown> = {}
): Promise<StealthResponse> {
  try {
    const res = await fetch(`${STEALTH_URL}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...params }),
    });
    if (!res.ok) {
      return {
        success: false,
        error: `HTTP ${res.status}: ${await res.text()}`,
      };
    }
    return (await res.json()) as StealthResponse;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

const server = new McpServer({
  name: "playwright-stealth-bridge",
  version: "1.0.0",
});

// Helper to resolve selector from ref or selector
function resolveSelector(selector?: string, ref?: string, defaultSelector = ""): string {
  if (selector && selector.trim()) return selector.trim();
  if (ref && ref.trim()) {
    // If ref looks like a number or id
    return `[data-ref="${ref.trim()}"]`;
  }
  return defaultSelector;
}

// 1. browser_navigate
server.tool(
  "browser_navigate",
  "Navigate to a URL in the stealth browser",
  { url: z.string().describe("The URL to navigate to") },
  async ({ url }) => {
    const res = await callStealth("goto", {
      url,
      wait_until: "domcontentloaded",
    });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 2. browser_click
server.tool(
  "browser_click",
  "Click an element on the page using a CSS or text selector",
  {
    selector: z.string().optional().describe("CSS selector or text selector"),
    ref: z.string().optional().describe("Element reference from snapshot"),
  },
  async ({ selector, ref }) => {
    const targetSelector = resolveSelector(selector, ref);
    if (!targetSelector) {
      return { content: [{ type: "text", text: "selector or ref is required" }], isError: true };
    }
    const res = await callStealth("click", { selector: targetSelector });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 3. browser_fill
server.tool(
  "browser_fill",
  "Fill an input field with text",
  {
    selector: z.string().optional().describe("CSS selector for input"),
    ref: z.string().optional().describe("Element reference from snapshot"),
    value: z.string().describe("Text value to fill"),
  },
  async ({ selector, ref, value }) => {
    const targetSelector = resolveSelector(selector, ref);
    if (!targetSelector) {
      return { content: [{ type: "text", text: "selector or ref is required" }], isError: true };
    }
    const res = await callStealth("fill", { selector: targetSelector, value });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 4. browser_type
server.tool(
  "browser_type",
  "Type text into an element with human-like key events",
  {
    text: z.string().describe("Text to type"),
    selector: z.string().optional().describe("CSS selector for input"),
    ref: z.string().optional().describe("Element reference from snapshot"),
    delay: z.number().optional().describe("Delay between keystrokes in seconds"),
  },
  async ({ text, selector, ref, delay }) => {
    const targetSelector = resolveSelector(selector, ref);
    let res: StealthResponse;
    if (targetSelector) {
      res = await callStealth("type", { selector: targetSelector, text, delay: delay ?? 0.05 });
    } else {
      res = await callStealth("system_type", { text });
    }
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 5. browser_fill_form
server.tool(
  "browser_fill_form",
  "Fill multiple form fields sequentially",
  {
    fields: z.array(
      z.object({
        selector: z.string().optional(),
        ref: z.string().optional(),
        value: z.string(),
      })
    ).describe("Array of fields to fill"),
  },
  async ({ fields }) => {
    const results = [];
    for (const f of fields) {
      const targetSelector = resolveSelector(f.selector, f.ref);
      if (targetSelector) {
        const res = await callStealth("fill", { selector: targetSelector, value: f.value });
        results.push({ field: targetSelector, res });
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      isError: false,
    };
  }
);

// 6. browser_file_upload
server.tool(
  "browser_file_upload",
  "Upload one or more files to a file input element",
  {
    paths: z.array(z.string()).optional().describe("Array of file paths to upload"),
    path: z.string().optional().describe("Single file path to upload"),
    file_path: z.string().optional().describe("Alternative single file path to upload"),
    selector: z.string().optional().describe("CSS selector for file input (defaults to input[type='file'])"),
    ref: z.string().optional().describe("Element reference from snapshot"),
  },
  async ({ paths, path: singlePath, file_path, selector, ref }) => {
    let targetFile = (paths && paths.length > 0 ? paths[0] : (singlePath || file_path)) || "";
    if (!targetFile) {
      return { content: [{ type: "text", text: "No file path provided to upload" }], isError: true };
    }

    // Ensure the file is also duplicated into /app/shared/tmp/ as a shared volume fallback
    try {
      if (fs.existsSync(targetFile)) {
        const sharedTmpDir = "/app/shared/tmp";
        await fsPromises.mkdir(sharedTmpDir, { recursive: true });
        const sharedDest = path.join(sharedTmpDir, path.basename(targetFile));
        await fsPromises.copyFile(targetFile, sharedDest);
        // If target file was in a local scratch path not starting with /app or /root, point to shared
        if (!targetFile.startsWith("/root/.jobpilot") && !targetFile.startsWith("/app/")) {
          targetFile = sharedDest;
        }
      }
    } catch {
      // Non-fatal, continue with original path
    }

    const targetSelector = resolveSelector(selector, ref, "input[type='file']");
    const res = await callStealth("upload_file", {
      selector: targetSelector,
      file_path: targetFile,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 7. upload_file (alias directly matching stealthy-auto-browse action)
server.tool(
  "upload_file",
  "Upload a file into a file input element in stealth-browser",
  {
    file_path: z.string().describe("Path to the file on disk"),
    selector: z.string().optional().default("input[type='file']").describe("CSS selector of file input"),
  },
  async ({ file_path, selector }) => {
    let targetFile = file_path;
    try {
      if (fs.existsSync(targetFile)) {
        const sharedTmpDir = "/app/shared/tmp";
        await fsPromises.mkdir(sharedTmpDir, { recursive: true });
        const sharedDest = path.join(sharedTmpDir, path.basename(targetFile));
        await fsPromises.copyFile(targetFile, sharedDest);
        if (!targetFile.startsWith("/root/.jobpilot") && !targetFile.startsWith("/app/")) {
          targetFile = sharedDest;
        }
      }
    } catch {
      // Non-fatal
    }

    const res = await callStealth("upload_file", {
      selector: selector || "input[type='file']",
      file_path: targetFile,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 8. browser_select_option
server.tool(
  "browser_select_option",
  "Select an option in a dropdown element",
  {
    selector: z.string().optional().describe("CSS selector for select element"),
    ref: z.string().optional().describe("Element reference from snapshot"),
    value: z.string().optional().describe("Option value or text to select"),
    values: z.array(z.string()).optional().describe("Array of values to select"),
  },
  async ({ selector, ref, value, values }) => {
    const targetSelector = resolveSelector(selector, ref);
    if (!targetSelector) {
      return { content: [{ type: "text", text: "selector or ref is required" }], isError: true };
    }
    const chosenValue = value || (values && values[0]) || "";
    const res = await callStealth("select", { selector: targetSelector, value: chosenValue });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 9. browser_press_key
server.tool(
  "browser_press_key",
  "Press a key or keyboard shortcut (e.g. Enter, Tab, Escape, Backspace)",
  {
    key: z.string().describe("Key or combo to press (e.g. enter, tab, ctrl+a)"),
  },
  async ({ key }) => {
    const res = await callStealth("send_key", { key: key.toLowerCase() });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 10. browser_snapshot
server.tool(
  "browser_snapshot",
  "Capture interactive elements and page text structure",
  {
    ref: z.string().optional().describe("Optional element reference to narrow snapshot"),
    interestingOnly: z.boolean().optional().describe("Filter to interactive elements only"),
  },
  async () => {
    const res = await callStealth("get_interactive_elements", { visible_only: true });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(res.data ?? res, null, 2),
        },
      ],
      isError: !res.success,
    };
  }
);

// 11. browser_wait_for
server.tool(
  "browser_wait_for",
  "Wait for an element or text to appear on the page",
  {
    selector: z.string().optional().describe("CSS selector to wait for"),
    text: z.string().optional().describe("Text to wait for"),
    timeout: z.number().optional().default(10).describe("Timeout in seconds"),
  },
  async ({ selector, text, timeout }) => {
    let res: StealthResponse;
    if (selector) {
      res = await callStealth("wait_for_element", { selector, timeout });
    } else if (text) {
      res = await callStealth("wait_for_text", { text, timeout });
    } else {
      res = await callStealth("sleep", { duration: 2 });
    }
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 12. browser_tabs
server.tool(
  "browser_tabs",
  "Manage browser tabs (list, switch, new, close)",
  {
    action: z.enum(["list", "new", "switch", "close"]).default("list"),
    index: z.number().optional(),
    url: z.string().optional(),
  },
  async ({ action, index, url }) => {
    let res: StealthResponse;
    if (action === "list") {
      res = await callStealth("list_tabs");
    } else if (action === "new") {
      res = await callStealth("new_tab", { url: url || "about:blank" });
    } else if (action === "switch") {
      res = await callStealth("switch_tab", { index: index ?? 0 });
    } else if (action === "close") {
      res = await callStealth("close_tab", { index: index ?? 0 });
    } else {
      res = { success: false, error: `Unknown action: ${action}` };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 13. browser_take_screenshot
server.tool(
  "browser_take_screenshot",
  "Take a screenshot of the page or desktop",
  {
    path: z.string().optional().describe("Optional path to save screenshot"),
  },
  async ({ path: outPath }) => {
    const params = outPath ? { path: outPath } : {};
    const res = await callStealth("save_screenshot", params);
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 14. browser_evaluate
server.tool(
  "browser_evaluate",
  "Evaluate a JavaScript expression on the page",
  {
    expression: z.string().describe("JavaScript expression to execute"),
  },
  async ({ expression }) => {
    const res = await callStealth("eval", { expression });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 15. browser_resize
server.tool(
  "browser_resize",
  "Check or calibrate browser display resolution",
  {
    width: z.number().optional(),
    height: z.number().optional(),
  },
  async () => {
    const res = await callStealth("get_resolution");
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error running playwright-stealth-bridge:", error);
  process.exit(1);
});
