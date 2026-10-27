import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";
import {
  getOrCreateAtsCredentials,
  saveAtsCredentials,
  listAtsCredentials,
  validateMasterSecret,
} from "./vault.js";
import {
  waitForVerificationEmail,
  pollRecentJobEmails,
} from "./imap.js";
import { solveCaptchaWithTokenService } from "./captcha.js";
import { compileAtsPdfViaCloakBrowser } from "./career-ops.js";

const { Pool } = pg;

const masterSecret = validateMasterSecret(process.env.ATS_VAULT_MASTER_SECRET);
const dbUrl = process.env.DATABASE_URL?.trim();
const pool = dbUrl ? new Pool({ connectionString: dbUrl }) : null;
pool?.on("error", (err) => {
  console.error("[jobbot-mcp] Unexpected PostgreSQL idle client error:", err);
});

const server = new McpServer({
  name: "jobbot-mcp",
  version: "1.1.0",
});

// 1. Multi-Tenant ATS Password Vault: Get or Auto-Create Credential
server.tool(
  "ats_get_or_create_credentials",
  "Retrieves an existing login or generates & saves a new AES-256-GCM encrypted login credential for a specific ATS tenant domain (e.g., nvidia.wd5.myworkdayjobs.com, icims.com, taleo.net).",
  {
    portalUrl: z
      .string()
      .trim()
      .min(1)
      .describe("Full URL or hostname of the ATS login/registration page"),
    companyName: z
      .string()
      .trim()
      .optional()
      .describe("Company name for this ATS portal"),
    emailOverride: z
      .string()
      .trim()
      .email()
      .optional()
      .describe("Optional email override; defaults to GMAIL_ADDRESS"),
  },
  async ({ portalUrl, companyName, emailOverride }) => {
    const email =
      emailOverride || process.env.GMAIL_ADDRESS || "applicant@example.com";
    const passwordPrefix =
      process.env.ATS_DEFAULT_PASSWORD_PREFIX || "JobBot#2026!";

    const creds = await getOrCreateAtsCredentials(pool, {
      portalUrl,
      companyName,
      email,
      masterSecret,
      passwordPrefix,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(creds, null, 2),
        },
      ],
    };
  }
);

// 2. Multi-Tenant ATS Password Vault: Explicitly Save or Update Password
server.tool(
  "ats_save_credentials",
  "Explicitly saves or updates a password for an ATS portal or job board in the encrypted Postgres vault AND syncs it to JobPilot's /api/credentials store. Call this after creating an account, resetting a password, or when the user provides a login.",
  {
    portalUrl: z
      .string()
      .trim()
      .min(1)
      .describe("Full URL or hostname of the ATS portal or job board"),
    email: z
      .string()
      .trim()
      .email()
      .optional()
      .describe("Account email address; defaults to GMAIL_ADDRESS"),
    password: z
      .string()
      .min(1)
      .describe("The password to save and encrypt"),
    companyName: z
      .string()
      .trim()
      .optional()
      .describe("Company or board name"),
    accountVerified: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether the account has been verified/activated"),
  },
  async ({ portalUrl, email, password, companyName, accountVerified }) => {
    const effectiveEmail =
      email || process.env.GMAIL_ADDRESS || "applicant@example.com";

    const saved = await saveAtsCredentials(pool, {
      portalUrl,
      companyName,
      email: effectiveEmail,
      password,
      masterSecret,
      accountVerified,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(saved, null, 2),
        },
      ],
    };
  }
);

// 3. Multi-Tenant ATS Password Vault: List Saved Portals
server.tool(
  "ats_list_credentials",
  "Lists all ATS portals and job boards that have saved credentials in the vault (without exposing plaintext passwords).",
  {},
  async () => {
    const items = await listAtsCredentials(pool);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: items.length, items }, null, 2),
        },
      ],
    };
  }
);

// 4. Real-Time Gmail IMAP 2FA / OTP / Magic Link Reader
server.tool(
  "gmail_wait_for_verification_code",
  "Polls Gmail via IMAP (App Password) for a recent 4-8 digit security/verification code or account activation link from the target ATS domain (Greenhouse, Workday, Ashby, Lever, etc.).",
  {
    boardDomain: z
      .string()
      .trim()
      .min(1)
      .describe("Target ATS or company domain (e.g., workday.com, greenhouse.io, ashbyhq.com)"),
    timeoutSeconds: z
      .number()
      .min(5)
      .max(120)
      .optional()
      .default(45)
      .describe("Maximum seconds to wait for the verification email (5-120)"),
  },
  async ({ boardDomain, timeoutSeconds }) => {
    const result = await waitForVerificationEmail({
      boardDomain,
      timeoutSeconds,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result ?? {}, null, 2),
        },
      ],
    };
  }
);

// 5. Gmail IMAP Pipeline Status Scanner
server.tool(
  "gmail_poll_application_updates",
  "Scans recent Gmail inbox messages via IMAP and classifies recruiter replies into confirmation, interview_invite, assessment_oa, rejection, or verification.",
  {
    sinceHours: z
      .number()
      .min(1)
      .max(720)
      .optional()
      .default(24)
      .describe("How many hours back to scan in the inbox (1-720)"),
  },
  async ({ sinceHours }) => {
    const updates = await pollRecentJobEmails(sinceHours);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: updates.length, items: updates }, null, 2),
        },
      ],
    };
  }
);

// 6. Layer 2 CAPTCHA Token Solver Fallback
server.tool(
  "solve_captcha_challenge",
  "Solves a reCAPTCHA v2/v3, hCaptcha, or Cloudflare Turnstile challenge via CapSolver/2Captcha token service if CloakBrowser C++ stealth checkbox click triggers an image challenge.",
  {
    pageUrl: z
      .string()
      .trim()
      .url()
      .describe("Full URL of the page containing the CAPTCHA"),
    siteKey: z
      .string()
      .trim()
      .min(1)
      .describe("The data-sitekey or k= parameter of the CAPTCHA widget"),
    captchaType: z
      .enum(["recaptcha_v2", "recaptcha_v3", "hcaptcha", "turnstile"])
      .describe("Type of CAPTCHA widget"),
  },
  async ({ pageUrl, siteKey, captchaType }) => {
    const res = await solveCaptchaWithTokenService({
      pageUrl,
      siteKey,
      captchaType,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(res, null, 2),
        },
      ],
    };
  }
);

// 7. Career-Ops ATS-Clean HTML-to-PDF Resume Compiler
server.tool(
  "career_ops_compile_pdf",
  "Compiles tailored resume HTML into an ATS-friendly single-page PDF in /app/shared/resumes using the CloakBrowser Chromium CDP instance.",
  {
    htmlContent: z
      .string()
      .trim()
      .min(1)
      .max(500_000)
      .describe("Tailored resume body in clean HTML (max 500KB)"),
    outputFilename: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe("Target filename (e.g., Derek_Resume_Stripe_Backend.pdf)"),
  },
  async ({ htmlContent, outputFilename }) => {
    const res = await compileAtsPdfViaCloakBrowser({
      htmlContent,
      outputFilename,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(res, null, 2),
        },
      ],
    };
  }
);

/**
 * Starts the stdio MCP server transport and connects all registered tools.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[jobbot-mcp] Fatal error:", err);
  process.exit(1);
});
