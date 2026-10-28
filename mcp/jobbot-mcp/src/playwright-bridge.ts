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
  { selector: z.string().describe("CSS selector or text selector") },
  async ({ selector }) => {
    const res = await callStealth("click", { selector });
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
    selector: z.string().describe("CSS selector for input"),
    value: z.string().describe("Text value to fill"),
  },
  async ({ selector, value }) => {
    const res = await callStealth("fill", { selector, value });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.success,
    };
  }
);

// 4. browser_snapshot
server.tool(
  "browser_snapshot",
  "Capture interactive elements and page text structure",
  {
    ref: z
      .string()
      .optional()
      .describe("Optional element reference to narrow snapshot"),
  },
  async () => {
    const res = await callStealth("get_interactive_elements");
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

// 5. browser_wait_for
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

// 6. browser_tabs
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

// 7. browser_take_screenshot
server.tool(
  "browser_take_screenshot",
  "Take a screenshot of the page or desktop",
  {},
  async () => {
    const res = await callStealth("save_screenshot");
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
