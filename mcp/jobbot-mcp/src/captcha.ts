export interface CaptchaSolveRequest {
  pageUrl: string;
  siteKey: string;
  captchaType: "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "turnstile";
}

export interface CaptchaSolveResult {
  solved: boolean;
  provider: string;
  token: string | null;
  error?: string;
}

/**
 * Layer 2 CAPTCHA token solver fallback (CapSolver / 2Captcha).
 * Triggered only when an ATS form presents a hard image-grid challenge that survives
 * Layer 1 (CloakBrowser C++-patched Chromium + native checkbox click).
 */
export async function solveCaptchaWithTokenService(
  req: CaptchaSolveRequest
): Promise<CaptchaSolveResult> {
  const capsolverKey = process.env.CAPSOLVER_API_KEY?.trim();
  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY?.trim();

  if (capsolverKey) {
    return solveViaCapSolver(capsolverKey, req);
  }
  if (twocaptchaKey) {
    return solveViaTwoCaptcha(twocaptchaKey, req);
  }

  return {
    solved: false,
    provider: "none",
    token: null,
    error:
      "No CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY configured in .env. Relying on CloakBrowser C++ stealth checkbox/audio bypass.",
  };
}

/**
 * Submits and polls a CAPTCHA task via the CapSolver JSON API with per-request timeouts.
 */
async function solveViaCapSolver(
  apiKey: string,
  req: CaptchaSolveRequest
): Promise<CaptchaSolveResult> {
  const taskTypeMap: Record<CaptchaSolveRequest["captchaType"], string> = {
    recaptcha_v2: "ReCaptchaV2TaskProxyLess",
    recaptcha_v3: "ReCaptchaV3TaskProxyLess",
    hcaptcha: "HCaptchaTaskProxyless",
    turnstile: "AntiTurnstileTaskProxyLess",
  };

  try {
    const createResp = await fetch("https://api.capsolver.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: taskTypeMap[req.captchaType],
          websiteURL: req.pageUrl,
          websiteKey: req.siteKey,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const createData = (await createResp.json()) as {
      errorId?: number;
      errorDescription?: string;
      taskId?: string;
    };

    if (createData.errorId || !createData.taskId) {
      return {
        solved: false,
        provider: "capsolver",
        token: null,
        error: createData.errorDescription || "Failed to create CapSolver task",
      };
    }

    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollResp = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: apiKey,
          taskId: createData.taskId,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const pollData = (await pollResp.json()) as {
        status?: string;
        solution?: { gRecaptchaResponse?: string; token?: string };
        errorDescription?: string;
      };

      if (pollData.status === "ready") {
        const token =
          pollData.solution?.gRecaptchaResponse ||
          pollData.solution?.token ||
          null;
        return {
          solved: Boolean(token),
          provider: "capsolver",
          token,
        };
      }
      if (pollData.status === "failed") {
        return {
          solved: false,
          provider: "capsolver",
          token: null,
          error: pollData.errorDescription || "CapSolver task failed",
        };
      }
    }

    return {
      solved: false,
      provider: "capsolver",
      token: null,
      error: "CapSolver timed out after 72 seconds",
    };
  } catch (err) {
    return {
      solved: false,
      provider: "capsolver",
      token: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Submits and polls a CAPTCHA task via the 2Captcha API v2 JSON endpoint (sending key in POST body).
 */
async function solveViaTwoCaptcha(
  apiKey: string,
  req: CaptchaSolveRequest
): Promise<CaptchaSolveResult> {
  const typeMap: Record<CaptchaSolveRequest["captchaType"], string> = {
    recaptcha_v2: "RecaptchaV2TaskProxyless",
    recaptcha_v3: "RecaptchaV3TaskProxyless",
    hcaptcha: "HCaptchaTaskProxyless",
    turnstile: "TurnstileTaskProxyless",
  };

  try {
    const createResp = await fetch("https://api.2captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: typeMap[req.captchaType],
          websiteURL: req.pageUrl,
          websiteKey: req.siteKey,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const createData = (await createResp.json()) as {
      errorId?: number;
      errorDescription?: string;
      taskId?: number | string;
    };

    if (createData.errorId || !createData.taskId) {
      return {
        solved: false,
        provider: "2captcha",
        token: null,
        error: createData.errorDescription || "Failed to create 2Captcha task",
      };
    }

    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const resResp = await fetch("https://api.2captcha.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: apiKey,
          taskId: createData.taskId,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const resData = (await resResp.json()) as {
        errorId?: number;
        errorDescription?: string;
        status?: string;
        solution?: { gRecaptchaResponse?: string; token?: string };
      };

      if (resData.errorId) {
        return {
          solved: false,
          provider: "2captcha",
          token: null,
          error: resData.errorDescription || "2Captcha error",
        };
      }

      if (resData.status === "ready") {
        const token =
          resData.solution?.gRecaptchaResponse ||
          resData.solution?.token ||
          null;
        return {
          solved: Boolean(token),
          provider: "2captcha",
          token,
        };
      }
    }

    return {
      solved: false,
      provider: "2captcha",
      token: null,
      error: "2Captcha timed out",
    };
  } catch (err) {
    return {
      solved: false,
      provider: "2captcha",
      token: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
