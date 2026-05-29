import { NextRequest, NextResponse } from "next/server";

const ALLOWED_LAUNCHER_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostnameFromHost(host: string | null): string {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0] ?? "";
}

export function middleware(request: NextRequest) {
  const host = hostnameFromHost(request.headers.get("host"));
  if (!ALLOWED_LAUNCHER_HOSTS.has(host)) {
    return NextResponse.json({ ok: false, reason: "launcher_localhost_only" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/launcher/:path*"],
};
