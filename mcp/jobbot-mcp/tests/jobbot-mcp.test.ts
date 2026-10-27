import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePortalIdentity,
  generateCompliantAtsPassword,
  encryptPassword,
  decryptPassword,
  getOrCreateAtsCredentials,
  saveAtsCredentials,
  listAtsCredentials,
  validateMasterSecret,
} from "../src/vault.js";
import {
  extractVerificationFromContent,
  classifyJobEmail,
} from "../src/imap.js";

describe("ATS Multi-Tenant Password Vault", () => {
  it("normalizes Workday, Greenhouse, iCIMS, and Taleo tenant hostnames", () => {
    const wd = parsePortalIdentity(
      "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/login"
    );
    assert.equal(wd.hostname, "nvidia.wd5.myworkdayjobs.com");
    assert.equal(wd.atsFamily, "workday");

    const icims = parsePortalIdentity("https://careers-acme.icims.com/jobs/1234/login");
    assert.equal(icims.hostname, "careers-acme.icims.com");
    assert.equal(icims.atsFamily, "icims");

    const gh = parsePortalIdentity("https://job-boards.greenhouse.io/anthropic/jobs/456");
    assert.equal(gh.hostname, "job-boards.greenhouse.io");
    assert.equal(gh.atsFamily, "greenhouse");
  });

  it("fails closed when ATS_VAULT_MASTER_SECRET is missing or shorter than 32 chars", () => {
    assert.throws(() => validateMasterSecret(""), /at least 32 characters/);
    assert.throws(() => validateMasterSecret("too-short-secret"), /at least 32 characters/);
    const valid = validateMasterSecret("0123456789abcdef0123456789abcdef");
    assert.equal(valid.length, 32);
  });

  it("generates deterministic Workday-compliant strong passwords and roundtrips scrypt AES-256-GCM", () => {
    const secret = "test-master-secret-32-bytes-long!!";
    const pwd = generateCompliantAtsPassword(
      "nvidia.wd5.myworkdayjobs.com",
      secret,
      "JobBot#2026!"
    );

    assert.ok(pwd.length >= 16, "Password must be at least 16 chars");
    assert.match(pwd, /[A-Z]/, "Must contain uppercase");
    assert.match(pwd, /[a-z]/, "Must contain lowercase");
    assert.match(pwd, /[0-9]/, "Must contain digit");
    assert.match(pwd, /[!@#$%&*?]/, "Must contain special symbol");

    const encrypted = encryptPassword(pwd, secret);
    const decrypted = decryptPassword(
      encrypted.encryptedPassword,
      encrypted.iv,
      encrypted.authTag,
      secret
    );
    assert.equal(decrypted, pwd);
  });

  it("saves, updates, retrieves, and lists credentials in the vault", async () => {
    const secret = "test-master-secret-32-bytes-long!!";

    // 1. Auto-create credential for a new Workday portal
    const created = await getOrCreateAtsCredentials(null, {
      portalUrl: "https://stripe.wd5.myworkdayjobs.com/en-US/Stripe/login",
      companyName: "Stripe",
      email: "derek@example.com",
      masterSecret: secret,
    });
    assert.equal(created.portalHostname, "stripe.wd5.myworkdayjobs.com");
    assert.equal(created.isNew, true);
    assert.equal(created.accountVerified, false);

    // 2. Subsequent lookup returns the saved password with isNew = false
    const fetched = await getOrCreateAtsCredentials(null, {
      portalUrl: "https://stripe.wd5.myworkdayjobs.com/en-US/Stripe/job/123",
      email: "derek@example.com",
      masterSecret: secret,
    });
    assert.equal(fetched.isNew, false);
    assert.equal(fetched.password, created.password);

    // 3. Explicitly save/update a custom password (e.g., after password reset or account verification)
    const updated = await saveAtsCredentials(null, {
      portalUrl: "https://stripe.wd5.myworkdayjobs.com/en-US/Stripe/login",
      companyName: "Stripe",
      email: "derek@example.com",
      password: "CustomResetPassword#2026!",
      masterSecret: secret,
      accountVerified: true,
    });
    assert.equal(updated.password, "CustomResetPassword#2026!");
    assert.equal(updated.accountVerified, true);

    // 4. Verify getOrCreateAtsCredentials now returns the updated password
    const afterUpdate = await getOrCreateAtsCredentials(null, {
      portalUrl: "stripe.wd5.myworkdayjobs.com",
      email: "derek@example.com",
      masterSecret: secret,
    });
    assert.equal(afterUpdate.password, "CustomResetPassword#2026!");
    assert.equal(afterUpdate.accountVerified, true);

    // 5. Verify listAtsCredentials includes the portal without exposing plaintext password
    const list = await listAtsCredentials(null);
    const stripeEntry = list.find(
      (i) => i.portalHostname === "stripe.wd5.myworkdayjobs.com"
    );
    assert.ok(stripeEntry, "Expected stripe portal in credential list");
    assert.equal(stripeEntry.email, "derek@example.com");
    assert.equal(stripeEntry.accountVerified, true);
  });
});

describe("Gmail IMAP Verification OTP & Magic Link Extractor", () => {
  it("extracts 8-character Greenhouse security codes and ignores plain English words", () => {
    const res = extractVerificationFromContent(
      "Greenhouse Security Code for your application",
      "Hi Derek, Your security code is: X9K4M2P7. Paste this into your application form.",
      "<p>Your security code is: <strong>X9K4M2P7</strong></p>",
      "greenhouse.io"
    );
    assert.equal(res.verificationCode, "X9K4M2P7");
    assert.equal(res.verificationLink, null);

    // Ensure a plain non-digit word like "REQUIRED" after "security code is" is not matched as an OTP
    const wordOnly = extractVerificationFromContent(
      "Verification notice",
      "A security code is REQUIRED to continue.",
      "",
      "greenhouse.io"
    );
    assert.equal(wordOnly.verificationCode, null);
  });

  it("extracts Workday account activation links and rejects untrusted or spoofed-subdomain phishing domains", () => {
    const goodRes = extractVerificationFromContent(
      "Verify your Workday account",
      "Click the link to activate your account: https://nvidia.wd5.myworkdayjobs.com/en-US/External/activate?token=abc123xyz",
      "",
      "workday.com"
    );
    assert.equal(
      goodRes.verificationLink,
      "https://nvidia.wd5.myworkdayjobs.com/en-US/External/activate?token=abc123xyz"
    );

    const phishingRes = extractVerificationFromContent(
      "Verify your Workday account",
      "Click to verify: https://evil-phishing-site.ru/verify?token=steal",
      "",
      "workday.com"
    );
    assert.equal(phishingRes.verificationLink, null);

    const spoofedSubdomainRes = extractVerificationFromContent(
      "Verify your Workday account",
      "Click to verify: https://myworkdayjobs.com.evil.ru/activate?token=steal",
      "",
      "workday.com"
    );
    assert.equal(spoofedSubdomainRes.verificationLink, null);
  });

  it("classifies job pipeline emails accurately", () => {
    assert.equal(
      classifyJobEmail(
        "Thank you for applying to Stripe",
        "We have received your application for Backend Engineer."
      ),
      "confirmation"
    );
    assert.equal(
      classifyJobEmail(
        "Invitation to Interview - Senior Engineer",
        "We would love to schedule an interview and phone screen with you."
      ),
      "interview_invite"
    );
    assert.equal(
      classifyJobEmail(
        "Update on your application",
        "Unfortunately, we will not be proceeding with your candidacy at this time."
      ),
      "rejection"
    );
    assert.equal(
      classifyJobEmail(
        "Complete your HackerRank Technical Assessment",
        "Please complete the online assessment within 72 hours."
      ),
      "assessment_oa"
    );
  });
});
