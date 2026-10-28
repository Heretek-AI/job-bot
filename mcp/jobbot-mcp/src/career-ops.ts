import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

let pdfCompileQueue: Promise<unknown> = Promise.resolve();

/**
 * Serializes PDF compilation operations so concurrent invocations do not contend.
 */
function withPdfMutex<T>(fn: () => Promise<T>): Promise<T> {
  const next = pdfCompileQueue.then(fn, fn);
  pdfCompileQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * Compiles an ATS-clean HTML or Markdown resume into a single-page PDF using
 * Career-Ops's styling conventions via local headless Chromium or an optional CDP endpoint.
 */
export async function compileAtsPdf(params: {
  htmlContent: string;
  outputFilename: string;
  cdpUrl?: string;
  outputDir?: string;
}): Promise<{ pdfPath: string; bytes: number }> {
  return withPdfMutex(async () => {
    const cdpUrl = params.cdpUrl || process.env.CDP_URL || process.env.CLOAKBROWSER_CDP_URL;
    const outputDir =
      params.outputDir ||
      process.env.SHARED_RESUMES_DIR ||
      "/app/shared/resumes";

    await fs.mkdir(outputDir, { recursive: true });
    const safeName =
      params.outputFilename
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/\.pdf$/i, "") || "Resume";
    const pdfPath = path.join(outputDir, `${safeName}.pdf`);
    const tmpPath = `${pdfPath}.tmp-${process.pid}-${Date.now()}`;

    const fullHtml = params.htmlContent.includes("<html")
      ? params.htmlContent
      : `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: letter; margin: 0.45in 0.5in; }
    body {
      font-family: "Calibri", "Helvetica Neue", Arial, sans-serif;
      font-size: 10pt;
      line-height: 1.35;
      color: #111111;
      margin: 0;
      padding: 0;
    }
    h1 { font-size: 18pt; margin: 0 0 4pt 0; }
    h2 { font-size: 11pt; text-transform: uppercase; border-bottom: 1px solid #333; margin: 10pt 0 4pt 0; padding-bottom: 2pt; }
    h3 { font-size: 10.5pt; margin: 6pt 0 2pt 0; }
    p, ul { margin: 2pt 0 4pt 0; }
    ul { padding-left: 16pt; }
    li { margin-bottom: 2pt; }
  </style>
</head>
<body>
${params.htmlContent}
</body>
</html>`;

    let browser;
    let shouldCloseBrowser = false;
    if (cdpUrl) {
      browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
    } else {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      shouldCloseBrowser = true;
    }

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(fullHtml, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      const pdfBuffer = await page.pdf({
        format: "Letter",
        printBackground: true,
        margin: {
          top: "0.45in",
          bottom: "0.45in",
          left: "0.5in",
          right: "0.5in",
        },
      });
      await fs.writeFile(tmpPath, pdfBuffer);
      await fs.rename(tmpPath, pdfPath);
      return { pdfPath, bytes: pdfBuffer.byteLength };
    } finally {
      await context.close().catch(() => undefined);
      if (shouldCloseBrowser) {
        await browser.close().catch(() => undefined);
      }
    }
  });
}

export const compileAtsPdfViaCloakBrowser = compileAtsPdf;
