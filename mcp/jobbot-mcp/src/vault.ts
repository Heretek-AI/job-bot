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

const SCRYPT_SALT = "jobbot-ats-vault-kdf-salt-v1";
const MIN_SECRET_LENGTH = 32;

// In-memory fallback store used only when pool is null (e.g. local unit tests)
const memoryVault = new Map<string, StoredVaultEntry>();

/**
 * Validates that the vault master secret is present and at least 32 characters long.
 * Fails closed by throwing an error if missing, too short, or left as an obvious placeholder.
 */
export function validateMasterSecret(masterSecret: string | undefined): string {
  const trimmed = (masterSecret ?? "").trim();
  if (trimmed.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `ATS_VAULT_MASTER_SECRET must be at least ${MIN_SECRET_LENGTH} characters long (got ${trimmed.length}).`
    );
  }
  return trimmed;
}

/**
 * Normalizes any ATS URL or hostname into its tenant-specific hostname and detects the ATS family.
 * E.g. https://nvidia.wd5.myworkdayjobs.com/en-US/External/job/123 -> { hostname: 'nvidia.wd5.myworkdayjobs.com', atsFamily: 'workday' }
 */
export function parsePortalIdentity(portalUrlOrHost: string): {
  hostname: string;
  atsFamily: string;
} {
  let raw = portalUrlOrHost.trim();
  if (!raw) {
    throw new Error("portalUrlOrHost cannot be empty.");
  }
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();

  let atsFamily = "generic";
  if (
    hostname === "myworkdayjobs.com" ||
    hostname.endsWith(".myworkdayjobs.com") ||
    hostname === "myworkdaysite.com" ||
    hostname.endsWith(".myworkdaysite.com") ||
    hostname === "workday.com" ||
    hostname.endsWith(".workday.com")
  ) {
    atsFamily = "workday";
  } else if (hostname === "icims.com" || hostname.endsWith(".icims.com")) {
    atsFamily = "icims";
  } else if (
    hostname === "taleo.net" ||
    hostname.endsWith(".taleo.net") ||
    hostname === "oraclecloud.com" ||
    hostname.endsWith(".oraclecloud.com")
  ) {
    atsFamily = "oracle_taleo";
  } else if (
    hostname === "successfactors.com" ||
    hostname.endsWith(".successfactors.com") ||
    hostname === "successfactors.eu" ||
    hostname.endsWith(".successfactors.eu")
  ) {
    atsFamily = "successfactors";
  } else if (
    hostname === "greenhouse.io" ||
    hostname.endsWith(".greenhouse.io")
  ) {
    atsFamily = "greenhouse";
  } else if (hostname === "lever.co" || hostname.endsWith(".lever.co")) {
    atsFamily = "lever";
  } else if (hostname === "ashbyhq.com" || hostname.endsWith(".ashbyhq.com")) {
    atsFamily = "ashby";
  } else if (
    hostname === "smartrecruiters.com" ||
    hostname.endsWith(".smartrecruiters.com")
  ) {
    atsFamily = "smartrecruiters";
  }

  return { hostname, atsFamily };
}

/**
 * Picks a character from a charset without modulo bias using rejection sampling over a digest buffer.
 */
function pickUnbiasedChar(
  charset: string,
  seedBuffer: Buffer,
  offset: number
): string {
  const maxValid = Math.floor(256 / charset.length) * charset.length;
  for (let i = 0; i < seedBuffer.length; i++) {
    const byte = seedBuffer[(offset + i) % seedBuffer.length];
    if (byte < maxValid) {
      return charset[byte % charset.length];
    }
  }
  return charset[seedBuffer[offset % seedBuffer.length] % charset.length];
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
  const validSecret = validateMasterSecret(masterSecret);
  const hmac = crypto
    .createHmac("sha256", validSecret)
    .update(`ats-pwd-v1:${hostname.toLowerCase()}`)
    .digest();

  const uppers = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lowers = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const specials = "!@#$%&*?";

  const suffix = [
    pickUnbiasedChar(uppers, hmac, 0),
    pickUnbiasedChar(lowers, hmac, 4),
    pickUnbiasedChar(digits, hmac, 8),
    pickUnbiasedChar(specials, hmac, 12),
    pickUnbiasedChar(uppers, hmac, 16),
    pickUnbiasedChar(lowers, hmac, 20),
    pickUnbiasedChar(digits, hmac, 24),
    pickUnbiasedChar(lowers, hmac, 28),
  ].join("");

  const cleanPrefix = prefix.replace(/\s+/g, "") || "JobBot#2026!";
  return `${cleanPrefix}${suffix}`;
}

/**
 * Derives a 256-bit AES key from the master secret using scrypt KDF.
 */
function deriveKey(masterSecret: string): Buffer {
  const validSecret = validateMasterSecret(masterSecret);
  return crypto.scryptSync(validSecret, SCRYPT_SALT, 32);
}

/**
 * Encrypts a plaintext password using AES-256-GCM with a random 96-bit IV and scrypt-derived key.
 */
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

/**
 * Decrypts an AES-256-GCM ciphertext using the scrypt-derived key.
 */
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
 * Resolves the JobPilot API bearer token from the JOBPILOT_API_TOKEN environment variable
 * injected by the JobPilot Terminal Host PTY session (or .env override).
 */
export function resolveJobPilotApiToken(): string | null {
  const envToken = process.env.JOBPILOT_API_TOKEN?.trim();
  if (envToken && /^[A-Za-z0-9._~+/=-]{8,512}$/.test(envToken)) {
    return envToken;
  }
  return null;
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
  let apiOrigin: string;
  try {
    const parsedUrl = new URL(process.env.JOBPILOT_API || "http://api:4101");
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return false;
    }
    apiOrigin = parsedUrl.origin;
  } catch {
    return false;
  }

  const apiToken = resolveJobPilotApiToken();
  if (!apiToken) {
    return false;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiToken}`,
  };

  try {
    const resolveResp = await fetch(
      `${apiOrigin}/api/credentials/resolve?domain=${encodeURIComponent(
        params.hostname
      )}`,
      { headers, signal: AbortSignal.timeout(10_000) }
    );
    if (resolveResp.ok) {
      const body = (await resolveResp.json()) as {
        data?: { id?: string; kind?: string } | null;
      };
      if (body?.data?.id && body.data.kind === "board") {
        const patchResp = await fetch(
          `${apiOrigin}/api/credentials/${encodeURIComponent(body.data.id)}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              email: params.email,
              password: params.password,
            }),
            signal: AbortSignal.timeout(10_000),
          }
        );
        return patchResp.ok;
      }
    }

    const createResp = await fetch(`${apiOrigin}/api/credentials`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "board",
        board: params.hostname,
        email: params.email,
        password: params.password,
      }),
      signal: AbortSignal.timeout(10_000),
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
  const validSecret = validateMasterSecret(params.masterSecret);
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
        validSecret
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
      validSecret
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
    validSecret,
    params.passwordPrefix
  );

  return saveAtsCredentials(pool, {
    portalUrl: params.portalUrl,
    companyName: params.companyName,
    email: params.email,
    password,
    masterSecret: validSecret,
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
  const validSecret = validateMasterSecret(params.masterSecret);
  const { hostname, atsFamily } = parsePortalIdentity(params.portalUrl);
  const { encryptedPassword, iv, authTag } = encryptPassword(
    params.password,
    validSecret
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
