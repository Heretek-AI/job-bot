import crypto from "node:crypto";
import type { Pool } from "pg";

export interface AtsCredentialRecord {
  portalHostname: string;
  atsFamily: string;
  companyName: string | null;
  email: string;
  password: string;
  isNew: boolean;
  accountVerified: boolean;
  syncedToJobPilotApi?: boolean;
}

export interface AtsCredentialSummary {
  portalHostname: string;
  atsFamily: string;
  companyName: string | null;
  email: string;
  accountVerified: boolean;
  lastUsedAt: string;
}

interface StoredVaultEntry {
  portalHostname: string;
  atsFamily: string;
  companyName: string | null;
  email: string;
  encryptedPassword: string;
  iv: string;
  authTag: string;
  accountVerified: boolean;
  lastUsedAt: string;
}

// In-memory fallback store used when DATABASE_URL is not connected (e.g. local unit tests)
const memoryVault = new Map<string, StoredVaultEntry>();

/**
 * Normalizes any ATS URL into its tenant-specific hostname and detects the ATS family.
 * E.g. https://nvidia.wd5.myworkdayjobs.com/en-US/External/job/123 -> { hostname: 'nvidia.wd5.myworkdayjobs.com', atsFamily: 'workday' }
 */
export function parsePortalIdentity(portalUrlOrHost: string): {
  hostname: string;
  atsFamily: string;
} {
  let raw = portalUrlOrHost.trim();
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();

  let atsFamily = "generic";
  if (
    hostname.includes("myworkdayjobs.com") ||
    hostname.includes("myworkdaysite.com") ||
    hostname.endsWith("workday.com")
  ) {
    atsFamily = "workday";
  } else if (hostname.includes("icims.com")) {
    atsFamily = "icims";
  } else if (hostname.includes("taleo.net") || hostname.includes("oraclecloud.com")) {
    atsFamily = "oracle_taleo";
  } else if (
    hostname.includes("successfactors.com") ||
    hostname.includes("successfactors.eu")
  ) {
    atsFamily = "successfactors";
  } else if (hostname.includes("greenhouse.io")) {
    atsFamily = "greenhouse";
  } else if (hostname.includes("lever.co")) {
    atsFamily = "lever";
  } else if (hostname.includes("ashbyhq.com")) {
    atsFamily = "ashby";
  } else if (hostname.includes("smartrecruiters.com")) {
    atsFamily = "smartrecruiters";
  }

  return { hostname, atsFamily };
}

/**
 * Generates a strong password that satisfies strict enterprise ATS password policies
 * (Workday, iCIMS, Oracle/Taleo, SuccessFactors):
 * - 16-20 chars
 * - Uppercase, lowercase, digits, special symbol (!@#$%^&*)
 */
export function generateCompliantAtsPassword(
  hostname: string,
  masterSecret: string,
  prefix = "JobBot#2026!"
): string {
  const hmac = crypto
    .createHmac("sha256", masterSecret)
    .update(`ats-pwd-v1:${hostname}`)
    .digest();

  const uppers = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lowers = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const specials = "!@#$%&*?";

  const pick = (charset: string, byteIndex: number) =>
    charset[hmac[byteIndex % hmac.length] % charset.length];

  const suffix = [
    pick(uppers, 0),
    pick(lowers, 1),
    pick(digits, 2),
    pick(specials, 3),
    pick(uppers, 4),
    pick(lowers, 5),
    pick(digits, 6),
    pick(lowers, 7),
  ].join("");

  const cleanPrefix = prefix.replace(/\s+/g, "") || "JobBot#2026!";
  return `${cleanPrefix}${suffix}`;
}

function deriveKey(masterSecret: string): Buffer {
  return crypto.createHash("sha256").update(masterSecret).digest();
}

export function encryptPassword(
  plainText: string,
  masterSecret: string
): {
  encryptedPassword: string;
  iv: string;
  authTag: string;
} {
  const key = deriveKey(masterSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedPassword: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptPassword(
  encryptedPassword: string,
  ivBase64: string,
  authTagBase64: string,
  masterSecret: string
): string {
  const key = deriveKey(masterSecret);
  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPassword, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Best-effort sync to JobPilot's native /api/credentials endpoint so saved passwords
 * also appear in the JobPilot Web UI under Credentials.
 */
export async function syncCredentialToJobPilotApi(params: {
  hostname: string;
  email: string;
  password: string;
}): Promise<boolean> {
  const apiUrl = (process.env.JOBPILOT_API || "http://api:4101").replace(/\/+$/, "");
  const apiToken = process.env.JOBPILOT_API_TOKEN?.trim();
  if (!apiToken) {
    return false;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiToken}`,
  };

  try {
    // 1. Check if a board credential already resolves for this domain
    const resolveResp = await fetch(
      `${apiUrl}/api/credentials/resolve?domain=${encodeURIComponent(params.hostname)}`,
      { headers }
    );
    if (resolveResp.ok) {
      const body = (await resolveResp.json()) as {
        data?: { id?: string; kind?: string } | null;
      };
      if (body?.data?.id && body.data.kind === "board") {
        const patchResp = await fetch(
          `${apiUrl}/api/credentials/${encodeURIComponent(body.data.id)}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              email: params.email,
              password: params.password,
            }),
          }
        );
        return patchResp.ok;
      }
    }

    // 2. Otherwise create a new board credential
    const createResp = await fetch(`${apiUrl}/api/credentials`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "board",
        board: params.hostname,
        email: params.email,
        password: params.password,
      }),
    });
    return createResp.ok;
  } catch {
    return false;
  }
}

/**
 * Retrieves an existing ATS credential for a portal or generates & saves a new one.
 */
export async function getOrCreateAtsCredentials(
  pool: Pool | null,
  params: {
    portalUrl: string;
    companyName?: string;
    email: string;
    masterSecret: string;
    passwordPrefix?: string;
  }
): Promise<AtsCredentialRecord> {
  const { hostname, atsFamily } = parsePortalIdentity(params.portalUrl);

  if (pool) {
    const existing = await pool.query(
      `SELECT portal_hostname, ats_family, company_name, email, encrypted_password, iv, auth_tag, account_verified
       FROM ats_credentials
       WHERE portal_hostname = $1`,
      [hostname]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      await pool.query(
        `UPDATE ats_credentials SET last_used_at = NOW() WHERE portal_hostname = $1`,
        [hostname]
      );
      const password = decryptPassword(
        row.encrypted_password,
        row.iv,
        row.auth_tag,
        params.masterSecret
      );
      return {
        portalHostname: row.portal_hostname,
        atsFamily: row.ats_family,
        companyName: row.company_name,
        email: row.email,
        password,
        isNew: false,
        accountVerified: row.account_verified,
      };
    }
  } else if (memoryVault.has(hostname)) {
    const entry = memoryVault.get(hostname)!;
    entry.lastUsedAt = new Date().toISOString();
    const password = decryptPassword(
      entry.encryptedPassword,
      entry.iv,
      entry.authTag,
      params.masterSecret
    );
    return {
      portalHostname: entry.portalHostname,
      atsFamily: entry.atsFamily,
      companyName: entry.companyName,
      email: entry.email,
      password,
      isNew: false,
      accountVerified: entry.accountVerified,
    };
  }

  const password = generateCompliantAtsPassword(
    hostname,
    params.masterSecret,
    params.passwordPrefix
  );

  return saveAtsCredentials(pool, {
    portalUrl: params.portalUrl,
    companyName: params.companyName,
    email: params.email,
    password,
    masterSecret: params.masterSecret,
    accountVerified: false,
    isNewFlag: true,
  });
}

/**
 * Explicitly saves or updates an ATS/Job-Board login credential in PostgreSQL
 * (and syncs to JobPilot's /api/credentials store when paired).
 */
export async function saveAtsCredentials(
  pool: Pool | null,
  params: {
    portalUrl: string;
    companyName?: string;
    email: string;
    password: string;
    masterSecret: string;
    accountVerified?: boolean;
    isNewFlag?: boolean;
  }
): Promise<AtsCredentialRecord> {
  const { hostname, atsFamily } = parsePortalIdentity(params.portalUrl);
  const { encryptedPassword, iv, authTag } = encryptPassword(
    params.password,
    params.masterSecret
  );
  const verified = params.accountVerified ?? true;

  if (pool) {
    await pool.query(
      `INSERT INTO ats_credentials (
         portal_hostname, ats_family, company_name, email, encrypted_password, iv, auth_tag, account_verified, last_used_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (portal_hostname) DO UPDATE SET
         ats_family = EXCLUDED.ats_family,
         company_name = COALESCE(EXCLUDED.company_name, ats_credentials.company_name),
         email = EXCLUDED.email,
         encrypted_password = EXCLUDED.encrypted_password,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         account_verified = EXCLUDED.account_verified,
         last_used_at = NOW()`,
      [
        hostname,
        atsFamily,
        params.companyName ?? null,
        params.email,
        encryptedPassword,
        iv,
        authTag,
        verified,
      ]
    );
  } else {
    memoryVault.set(hostname, {
      portalHostname: hostname,
      atsFamily,
      companyName: params.companyName ?? null,
      email: params.email,
      encryptedPassword,
      iv,
      authTag,
      accountVerified: verified,
      lastUsedAt: new Date().toISOString(),
    });
  }

  const synced = await syncCredentialToJobPilotApi({
    hostname,
    email: params.email,
    password: params.password,
  });

  return {
    portalHostname: hostname,
    atsFamily,
    companyName: params.companyName ?? null,
    email: params.email,
    password: params.password,
    isNew: params.isNewFlag ?? false,
    accountVerified: verified,
    syncedToJobPilotApi: synced,
  };
}

/**
 * Lists all saved ATS credentials (metadata only, no plaintext passwords).
 */
export async function listAtsCredentials(
  pool: Pool | null
): Promise<AtsCredentialSummary[]> {
  if (pool) {
    const res = await pool.query(
      `SELECT portal_hostname, ats_family, company_name, email, account_verified, last_used_at
       FROM ats_credentials
       ORDER BY last_used_at DESC`
    );
    return res.rows.map((r) => ({
      portalHostname: r.portal_hostname,
      atsFamily: r.ats_family,
      companyName: r.company_name,
      email: r.email,
      accountVerified: Boolean(r.account_verified),
      lastUsedAt: new Date(r.last_used_at).toISOString(),
    }));
  }

  return Array.from(memoryVault.values()).map((e) => ({
    portalHostname: e.portalHostname,
    atsFamily: e.atsFamily,
    companyName: e.companyName,
    email: e.email,
    accountVerified: e.accountVerified,
    lastUsedAt: e.lastUsedAt,
  }));
}
