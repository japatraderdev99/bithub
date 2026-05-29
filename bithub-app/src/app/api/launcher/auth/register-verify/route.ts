import { NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { consumeChallenge, readCredStore, writeAudit, writeCredStore, type StoredCredential } from "@/lib/launcher-state";

export const dynamic = "force-dynamic";

const RP_ID = process.env.LAUNCHER_RP_ID ?? "localhost";
const EXPECTED_ORIGINS = [
  `http://${RP_ID}:3000`,
  `http://${RP_ID}:3001`,
  `https://${RP_ID}:3000`,
  `https://${RP_ID}:3001`,
];

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const challenge = consumeChallenge("register");
  if (!challenge) {
    return NextResponse.json({ ok: false, reason: "challenge_expired_or_missing" }, { status: 400 });
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: body as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: EXPECTED_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      writeAudit({ ts: new Date().toISOString(), event: "auth_verify_fail", reason: "registration_not_verified" });
      return NextResponse.json({ ok: false, reason: "not_verified" }, { status: 400 });
    }

    const info = verification.registrationInfo;
    // @simplewebauthn returns Uint8Arrays; convert to base64url for storage.
    const cred = info.credential;
    const store = readCredStore();
    const stored: StoredCredential = {
      credentialID: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString("base64url"),
      counter: cred.counter ?? 0,
      transports: cred.transports ? [...cred.transports] : undefined,
      created_at: new Date().toISOString(),
      label: "MacBook Touch ID",
    };
    store.credentials.push(stored);
    writeCredStore(store);

    writeAudit({ ts: new Date().toISOString(), event: "auth_verify_ok", details: { credId: stored.credentialID.slice(0, 12) } });
    return NextResponse.json({ ok: true, credentialID: stored.credentialID.slice(0, 12) });
  } catch (e) {
    writeAudit({ ts: new Date().toISOString(), event: "auth_verify_fail", reason: (e as Error).message });
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 400 });
  }
}
