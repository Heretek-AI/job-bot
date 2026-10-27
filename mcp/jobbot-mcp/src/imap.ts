import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface ExtractedVerification {
  verificationCode: string | null;
  verificationLink: string | null;
  subject: string;
  fromAddress: string;
  receivedAt: string;
}

export interface ClassifiedEmailUpdate {
  messageId: string;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  classification:
    | "verification"
    | "confirmation"
    | "interview_invite"
    | "assessment_oa"
    | "rejection"
    | "other";
  verificationCode: string | null;
  verificationLink: string | null;
  snippet: string;
}

/**
 * Checks whether a candidate hostname matches or is a subdomain of the expected domain.
 */
function isHostMatchingDomain(host: string, targetDomain: string): boolean {
  const cleanHost = host.toLowerCase();
  const cleanTarget = targetDomain.toLowerCase();
  if (!cleanTarget) return false;
  return cleanHost === cleanTarget || cleanHost.endsWith(`.${cleanTarget}`);
}

/**
 * Safely extracts a 4-8 character verification OTP code and/or a magic verification link
 * whose hostname belongs to the target boardDomain (preventing phishing or tracking links).
 */
export function extractVerificationFromContent(
  subject: string,
  textBody: string,
  htmlBody: string,
  boardDomain: string
): { verificationCode: string | null; verificationLink: string | null } {
  const combinedText = `${subject}\n${textBody}`;
  const cleanDomain = boardDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");

  if (!cleanDomain) {
    return { verificationCode: null, verificationLink: null };
  }

  // 1. Extract explicit security/verification codes (Greenhouse 8-char alphanumeric containing >=1 digit, or 4-8 digit OTPs)
  let verificationCode: string | null = null;

  const explicitPatterns = [
    /(?:security|verification|confirmation|login|passcode|one-time)\s+code(?:\s+is)?[\s:–-]+((?=[A-Z0-9]*\d)[A-Z0-9]{4,8})\b/i,
    /\bcode[\s:–-]+((?=[A-Z0-9]*\d)[A-Z0-9]{6,8})\b/i,
    /\b(\d{6})\b/,
    /\b(\d{4,8})\b/,
  ];

  for (const regex of explicitPatterns) {
    const match = combinedText.match(regex);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // Avoid matching calendar years like 1990-2099
      if (!/^(19\d\d|20\d\d)$/.test(candidate)) {
        verificationCode = candidate;
        break;
      }
    }
  }

  // 2. Extract verification/activation URLs strictly scoped to the target board domain
  let verificationLink: string | null = null;
  const urlRegex = /https?:\/\/[^\s"'<>)+]+/gi;
  const allUrls = [
    ...(textBody.match(urlRegex) ?? []),
    ...(htmlBody.match(urlRegex) ?? []),
  ];

  const baseDomainParts = cleanDomain.split(".");
  const rootDomain =
    baseDomainParts.length >= 2
      ? baseDomainParts.slice(-2).join(".")
      : cleanDomain;

  for (const rawUrl of allUrls) {
    const cleanedUrl = rawUrl.replace(/&amp;/g, "&").replace(/[.,;!?]+$/, "");
    try {
      const parsed = new URL(cleanedUrl);
      const host = parsed.hostname.toLowerCase();
      const domainMatches =
        isHostMatchingDomain(host, cleanDomain) ||
        isHostMatchingDomain(host, rootDomain) ||
        (rootDomain === "workday.com" &&
          (isHostMatchingDomain(host, "myworkdayjobs.com") ||
            isHostMatchingDomain(host, "myworkdaysite.com")));

      if (!domainMatches) {
        continue;
      }

      const fullLower = cleanedUrl.toLowerCase();
      if (
        fullLower.includes("verify") ||
        fullLower.includes("confirm") ||
        fullLower.includes("activate") ||
        fullLower.includes("token") ||
        fullLower.includes("magic") ||
        fullLower.includes("auth")
      ) {
        verificationLink = cleanedUrl;
        break;
      }
    } catch {
      // Ignore malformed URLs
    }
  }

  return { verificationCode, verificationLink };
}

/**
 * Classifies a job-related email into pipeline stages based on subject and body patterns.
 */
export function classifyJobEmail(
  subject: string,
  bodyText: string
): ClassifiedEmailUpdate["classification"] {
  const text = `${subject}\n${bodyText}`.toLowerCase();

  if (
    /\b(verification code|security code|verify your email|activate your account|one-time passcode)\b/.test(
      text
    )
  ) {
    return "verification";
  }
  if (
    /\b(unfortunately|not moving forward|other candidates|will not be proceeding|regret to inform|decided to pursue other)\b/.test(
      text
    )
  ) {
    return "rejection";
  }
  if (
    /\b(hackerrank|codility|codesignal|online assessment|take-home|technical assessment|coding challenge)\b/.test(
      text
    )
  ) {
    return "assessment_oa";
  }
  if (
    /\b(schedule an interview|phone screen|invite you to interview|availability for a call|chat with our recruiting|calendly\.com)\b/.test(
      text
    )
  ) {
    return "interview_invite";
  }
  if (
    /\b(thank you for applying|application received|we have received your application|thanks for applying)\b/.test(
      text
    )
  ) {
    return "confirmation";
  }
  return "other";
}

/**
 * Creates a configured ImapFlow client using Gmail App Password credentials from the environment.
 */
function createImapClient(): ImapFlow {
  const user = (process.env.GMAIL_ADDRESS || "").trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  const host = (process.env.GMAIL_IMAP_HOST || "imap.gmail.com").trim();
  const port = Number(process.env.GMAIL_IMAP_PORT || 993);

  if (!user || !pass) {
    throw new Error(
      "GMAIL_ADDRESS and GMAIL_APP_PASSWORD must be set in .env to use Gmail IMAP tools."
    );
  }

  return new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
}

/**
 * Polls the Gmail inbox via IMAP for a verification code or activation link matching boardDomain.
 * Guarantees IMAP lock release and client logout in a finally block on all return paths.
 */
export async function waitForVerificationEmail(params: {
  boardDomain: string;
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
}): Promise<ExtractedVerification | null> {
  const cleanDomain = params.boardDomain.trim().toLowerCase();
  if (!cleanDomain) {
    throw new Error("boardDomain must be a non-empty domain string.");
  }

  const timeoutMs =
    Math.min(Math.max(params.timeoutSeconds ?? 45, 5), 120) * 1000;
  const pollMs =
    Math.min(Math.max(params.pollIntervalSeconds ?? 5, 2), 30) * 1000;
  const deadline = Date.now() + timeoutMs;
  // Exact cutoff timestamp (10-minute lookback window for clock skew / recent trigger)
  const exactCutoffMs = Date.now() - 10 * 60 * 1000;
  const sinceSearchDate = new Date(exactCutoffMs);

  const client = createImapClient();
  try {
    await client.connect();

    while (Date.now() <= deadline) {
      let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
      try {
        lock = await client.getMailboxLock("INBOX");
        const uids = await client.search(
          { since: sinceSearchDate },
          { uid: true }
        );
        if (uids && uids.length > 0) {
          const recentUids = uids.slice(-15).reverse();
          for (const uid of recentUids) {
            const msg = await client.fetchOne(
              String(uid),
              { source: true, envelope: true, internalDate: true },
              { uid: true }
            );
            if (!msg || !msg.source) continue;

            const parsed = await simpleParser(msg.source);
            const msgDate =
              (msg.internalDate ? new Date(msg.internalDate) : parsed.date) ||
              new Date(0);
            if (msgDate.getTime() < exactCutoffMs) {
              continue;
            }

            const subject = parsed.subject || "";
            const fromAddress = parsed.from?.value?.[0]?.address || "";
            const textBody = parsed.text || "";
            const htmlBody = typeof parsed.html === "string" ? parsed.html : "";

            const domainLower = cleanDomain.replace(/^https?:\/\//, "");
            const baseKeyword = domainLower.split(".")[0];
            const haystack =
              `${fromAddress} ${subject} ${textBody}`.toLowerCase();

            if (
              domainLower &&
              !haystack.includes(baseKeyword) &&
              !haystack.includes("greenhouse") &&
              !haystack.includes("workday") &&
              !haystack.includes("ashby") &&
              !haystack.includes("lever")
            ) {
              continue;
            }

            const { verificationCode, verificationLink } =
              extractVerificationFromContent(
                subject,
                textBody,
                htmlBody,
                cleanDomain
              );

            if (verificationCode || verificationLink) {
              return {
                verificationCode,
                verificationLink,
                subject,
                fromAddress,
                receivedAt: msgDate.toISOString(),
              };
            }
          }
        }
      } finally {
        lock?.release();
      }

      if (Date.now() + pollMs > deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }

    return null;
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore logout errors during cleanup
    }
  }
}

/**
 * Scans recent emails in the Gmail inbox and classifies recruiter/application status updates.
 */
export async function pollRecentJobEmails(
  sinceHours = 24
): Promise<ClassifiedEmailUpdate[]> {
  const clampedHours = Math.min(Math.max(sinceHours, 1), 720);
  const cutoffMs = Date.now() - clampedHours * 3600 * 1000;
  const sinceDate = new Date(cutoffMs);
  const results: ClassifiedEmailUpdate[] = [];

  const client = createImapClient();
  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock("INBOX");

    const uids = await client.search({ since: sinceDate }, { uid: true });
    if (uids && uids.length > 0) {
      const recentUids = uids.slice(-30).reverse();
      for (const uid of recentUids) {
        const msg = await client.fetchOne(
          String(uid),
          { source: true, envelope: true, internalDate: true },
          { uid: true }
        );
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);
        const msgDate =
          (msg.internalDate ? new Date(msg.internalDate) : parsed.date) ||
          new Date(0);
        if (msgDate.getTime() < cutoffMs) {
          continue;
        }

        const subject = parsed.subject || "";
        const fromAddress = parsed.from?.value?.[0]?.address || "";
        const textBody = parsed.text || "";
        const htmlBody = typeof parsed.html === "string" ? parsed.html : "";
        const classification = classifyJobEmail(subject, textBody);
        const senderDomain = fromAddress.split("@")[1] || "";

        const { verificationCode, verificationLink } =
          classification === "verification" && senderDomain
            ? extractVerificationFromContent(
                subject,
                textBody,
                htmlBody,
                senderDomain
              )
            : { verificationCode: null, verificationLink: null };

        results.push({
          messageId: parsed.messageId || `uid-${uid}`,
          fromAddress,
          subject,
          receivedAt: msgDate.toISOString(),
          classification,
          verificationCode,
          verificationLink,
          snippet: textBody.slice(0, 280).replace(/\s+/g, " ").trim(),
        });
      }
    }
  } finally {
    lock?.release();
    try {
      await client.logout();
    } catch {
      // Ignore logout errors during cleanup
    }
  }

  return results;
}
