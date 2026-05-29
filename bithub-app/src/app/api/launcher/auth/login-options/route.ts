import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { readCredStore, writeCredStore } from "@/lib/launcher-state";

export const dynamic = "force-dynamic";

const RP_ID = process.env.LAUNCHER_RP_ID ?? "localhost";

export async function POST() {
  const store = readCredStore();
  if (store.credentials.length === 0) {
    return NextResponse.json({ ok: false, reason: "no_registered_authenticator" }, { status: 404 });
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    timeout: 60_000,
    userVerification: "required",
    allowCredentials: store.credentials.map((c) => ({
      id: c.credentialID,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  });

  store.authChallenge = { value: options.challenge, expires_at: Date.now() + 60_000 };
  writeCredStore(store);

  return NextResponse.json(options);
}
