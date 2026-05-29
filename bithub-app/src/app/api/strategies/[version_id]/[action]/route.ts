import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dynamic = "force-dynamic";

const WORKER_URL =
  process.env.BITHUB_WORKER_URL ??
  "https://bithub-trades-api.guiydantas.workers.dev";

const ENV_PATH =
  process.env.BITHUB_ENV_PATH ??
  join(homedir(), "Documents", "Bithub Project", ".env");

function readIngestToken(): string | null {
  if (process.env.BITHUB_INGEST_TOKEN) return process.env.BITHUB_INGEST_TOKEN;
  try {
    const raw = readFileSync(ENV_PATH, "utf8");
    const match = raw.match(/^BITHUB_INGEST_TOKEN=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

interface Params {
  params: Promise<{ version_id: string; action: string }>;
}

export async function POST(request: Request, ctx: Params) {
  const { version_id, action } = await ctx.params;
  if (action !== "activate" && action !== "pause") {
    return NextResponse.json({ ok: false, reason: "invalid_action" }, { status: 400 });
  }
  const token = readIngestToken();
  if (!token) {
    return NextResponse.json({ ok: false, reason: "missing_ingest_token" }, { status: 500 });
  }

  let actor = "operator";
  try {
    const body = await request.json() as { actor?: string };
    if (typeof body.actor === "string" && body.actor.trim()) actor = body.actor.trim().slice(0, 64);
  } catch { /* empty body ok */ }

  const url = `${WORKER_URL}/strategy-versions/${encodeURIComponent(version_id)}/${action}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ actor }),
    });
    const body = await res.json() as Record<string, unknown>;
    return NextResponse.json(body, { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "worker_unreachable", detail: String(e) }, { status: 502 });
  }
}
