import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 dev server blocks `_next/*` for any host other than localhost
  // by default. We access the UI via 127.0.0.1 (same machine, no DNS), so
  // we explicitly allow it. Production builds are unaffected.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
