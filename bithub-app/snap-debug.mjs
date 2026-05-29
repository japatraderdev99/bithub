import { chromium } from "playwright";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

page.on("console", (m) => console.log(`[console:${m.type()}]`, m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("requestfailed", (r) => console.log("[reqfail]", r.url(), "→", r.failure()?.errorText));

const apiReqs = [];
page.on("request", (r) => {
  if (r.url().includes("/api/")) {
    apiReqs.push({ url: r.url() });
    console.log("[req →]", r.method(), r.url());
  }
});
page.on("response", async (r) => {
  if (r.url().includes("/api/")) {
    const body = await r.text().catch(() => "<no body>");
    console.log("[resp ←]", r.status(), r.url(), "→", body.slice(0, 150));
  }
});

await page.goto("http://127.0.0.1:3000/cockpit", { waitUntil: "load", timeout: 30000 });

// Run fetch directly in browser context as a sanity test
const directFetch = await page.evaluate(async () => {
  try {
    const r = await fetch("/api/monitor/positions", { cache: "no-store" });
    const j = await r.json();
    return { ok: r.ok, status: r.status, body: JSON.stringify(j).slice(0, 200) };
  } catch (e) {
    return { error: String(e) };
  }
});
console.log("[direct fetch from page context]", JSON.stringify(directFetch));

// Wait a few more seconds and see if any /api/ requests come naturally
await page.waitForTimeout(5000);
console.log("[summary] api requests captured:", apiReqs.length);

await browser.close();
