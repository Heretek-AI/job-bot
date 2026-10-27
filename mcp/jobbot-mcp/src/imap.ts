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

  // 1. Extract explicit security/verification codes (Greenhouse 8-char alphanumeric or 4-8 digit OTPs)
  let verificationCode: string | null = null;

  const explicitPatterns = [
    /(?:security|verification|confirmation|login|passcode|one-time)\s+code(?:\s+is)?[\s:–-]+([A-Z0-9]{4,8})\b/i,
    /\bcode[\s:–-]+([A-Z0-9]{6,8})\b/i,
    /\b(\d{6})\b/,
    /\b(\d{4,8})\b/,
  ];

  for (const regex of explicitPatterns) {
    const match = combinedText.match(regex);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // Avoid matching years like 2025/2026 unless explicitly labeled
      if (!/^(19\d\d|20[2-3]\d)$/.test(candidate)) {
        verificationCode = candidate;
        break;
      }
    }
  }

  // 2. Extract verification/activation URLs scoped to the target board domain (or known ATS email routers)
  let verificationLink: string | null = null;
  const urlRegex = /https?:\/\/[^\s"'<>)+]+/gi;
  const allUrls = [
    ...(textBody.match(urlRegex) ?? []),
    ...(htmlBody.match(urlRegex) ?? []),
  ];

  // Allowed base domains for the target board
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
        !cleanDomain ||
        host === cleanDomain ||
        host.endsWith(`.${cleanDomain}`) ||
        host === rootDomain ||
        host.endsWith(`.${rootDomain}`) ||
        (rootDomain.includes("workday") &&
          (host.includes("myworkdayjobs.com") || host.includes("myworkdaysite.com")));

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
 * Classifies a job-related email into pipeline stages.
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

function createImapClient(): ImapFlow {
  const user = process.env.GMAIL_ADDRESS || "";
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  const host = process.env.GMAIL_IMAP_HOST || "imap.gmail.com";
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

export async function waitForVerificationEmail(params: {
  boardDomain: string;
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
}): Promise<ExtractedVerification | null> {
  const timeoutMs = Math.min(Math.max(params.timeoutSeconds ?? 45, 5), 120) * 1000;
  const pollMs = (params.pollIntervalSeconds ?? 5) * 1000;
  const deadline = Date.now() + timeoutMs;
  const sinceWindow = new Date(Date.now() - 10 * 60 * 1000); // Look back 10 minutes

  while (Date.now() <= deadline) {
    const client = createImapClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = await client.search({ since: sinceWindow }, { uid: true });
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
            const subject = parsed.subject || "";
            const fromAddress = parsed.from?.value?.[0]?.address || "";
            const textBody = parsed.text || "";
            const htmlBody = typeof parsed.html === "string" ? parsed.html : "";

            const domainLower = params.boardDomain.toLowerCase().replace(/^https?:\/\//, "");
            const baseKeyword = domainLower.split(".")[0];
            const haystack = `${fromAddress} ${subject} ${textBody}`.toLowerCase();

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
                params.boardDomain
              );

            if (verificationCode || verificationLink) {
              return {
                verificationCode,
                verificationLink,
                subject,
                fromAddress,
                receivedAt: (parsed.date || new Date()).toISOString(),
              };
            }
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (err) {
      try {
        await client.logout();
      } catch {
        // ignore logout error
      }
      throw err;
    }

    if (Date.now() + pollMs > deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return null;
}

export async function pollRecentJobEmails(
  sinceHours = 24
): Promise<ClassifiedEmailUpdate[]> {
  const client = createImapClient();
  const sinceDate = new Date(Date.now() - sinceHours * 3600 * 1000);
  const results: ClassifiedEmailUpdate[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ since: sinceDate }, { uid: true });
      if (uids && uids.length > 0) {
        const recentUids = uids.slice(-30).reverse();
        for (const uid of recentUids) {
          const msg = await client.fetchOne(
            String(uid),
            { source: true, envelope: true },
            { uid: true }
          );
          if (!msg || !msg.source) continue;

          const parsed = await simpleParser(msg.source);
          const subject = parsed.subject || "";
          const fromAddress = parsed.from?.value?.[0]?.address || "";
          const textBody = parsed.text || "";
          const htmlBody = typeof parsed.html === "string" ? parsed.html : "";
          const classification = classifyJobEmail(subject, textBody);
          const senderDomain = fromAddress.split("@")[1] || "";

          const { verificationCode, verificationLink } =
            classification === "verification"
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
            receivedAt: (parsed.date || new Date()).toISOString(),
            classification,
            verificationCode,
            verificationLink,
            snippet: textBody.slice(0, 280).replace(/\s+/g, " ").trim(),
          });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    try {
      await client.logout();
    } catch {
      // ignore
    }
    throw err;
  }

  return results;
}
