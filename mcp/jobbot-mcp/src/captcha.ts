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
 * Layer 2 CAPTCHA token solver fallback (CapSolver / 2Captcha)
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
    });
    const pollData = (await pollResp.json()) as {
      status?: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
      errorDescription?: string;
    };

    if (pollData.status === "ready") {
      const token =
        pollData.solution?.gRecaptchaResponse || pollData.solution?.token || null;
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
}

async function solveViaTwoCaptcha(
  apiKey: string,
  req: CaptchaSolveRequest
): Promise<CaptchaSolveResult> {
  const methodMap: Record<CaptchaSolveRequest["captchaType"], string> = {
    recaptcha_v2: "userrecaptcha",
    recaptcha_v3: "userrecaptcha",
    hcaptcha: "hcaptcha",
    turnstile: "turnstile",
  };

  const params = new URLSearchParams({
    key: apiKey,
    method: methodMap[req.captchaType],
    pageurl: req.pageUrl,
    json: "1",
  });
  if (req.captchaType === "hcaptcha" || req.captchaType === "turnstile") {
    params.set("sitekey", req.siteKey);
  } else {
    params.set("googlekey", req.siteKey);
    if (req.captchaType === "recaptcha_v3") {
      params.set("version", "v3");
    }
  }

  const inResp = await fetch(`https://2captcha.com/in.php?${params.toString()}`);
  const inData = (await inResp.json()) as { status: number; request: string };
  if (inData.status !== 1) {
    return {
      solved: false,
      provider: "2captcha",
      token: null,
      error: inData.request,
    };
  }

  const taskId = inData.request;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const resResp = await fetch(
      `https://2captcha.com/res.php?key=${encodeURIComponent(
        apiKey
      )}&action=get&id=${encodeURIComponent(taskId)}&json=1`
    );
    const resData = (await resResp.json()) as { status: number; request: string };
    if (resData.status === 1) {
      return {
        solved: true,
        provider: "2captcha",
        token: resData.request,
      };
    }
    if (resData.request !== "CAPCHA_NOT_READY") {
      return {
        solved: false,
        provider: "2captcha",
        token: null,
        error: resData.request,
      };
    }
  }

  return {
    solved: false,
    provider: "2captcha",
    token: null,
    error: "2Captcha timed out",
  };
}
