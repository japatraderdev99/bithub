import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { readCredStore, writeAudit, writeCredStore } from "@/lib/launcher-state";

export const dynamic = "force-dynamic";

const RP_NAME = "Bithub Launcher";
// Operator-local only; localhost is the right RP for dev.
const RP_ID = process.env.LAUNCHER_RP_ID ?? "localhost";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const label = url.searchParams.get("label") ?? "MacBook Touch ID";

  const store = readCredStore();
  store.rpId = RP_ID;
  writeCredStore(store);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: "operator",
    userDisplayName: "Bithub Operator",
    timeout: 60_000,
    attestationType: "none",
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "required",
    },
    excludeCredentials: store.credentials.map((c) => ({
      id: c.credentialID,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  });

  // Stash exactly what the lib generated so verify uses the same challenge
  const fresh = readCredStore();
  fresh.registrationChallenge = { value: options.challenge, expires_at: Date.now() + 60_000 };
  writeCredStore(fresh);

  writeAudit({ ts: new Date().toISOString(), event: "auth_register", details: { label } });

  return NextResponse.json(options);
}
