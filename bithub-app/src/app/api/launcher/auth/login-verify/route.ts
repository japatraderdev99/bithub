import { NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";
import { consumeChallenge, mintIntentToken, readCredStore, writeAudit, writeCredStore } from "@/lib/launcher-state";

export const dynamic = "force-dynamic";

const RP_ID = process.env.LAUNCHER_RP_ID ?? "localhost";
const EXPECTED_ORIGINS = [
  `http://${RP_ID}:3000`,
  `http://${RP_ID}:3001`,
  `https://${RP_ID}:3000`,
  `https://${RP_ID}:3001`,
];

/**
 * On successful verification, mints a short-lived bearer "intent token" that
 * the UI can present to /monitor/start within ~30s. The token is single-use
 * and stored in cred store (single slot). This decouples the auth ceremony
 * from the actual spawn — and lets us audit the two steps separately.
 */

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const challenge = consumeChallenge("verify");
  if (!challenge) {
    return NextResponse.json({ ok: false, reason: "challenge_expired_or_missing" }, { status: 400 });
  }

  const store = readCredStore();
  const submitted = body as AuthenticationResponseJSON;
  const credentialID: string = submitted.id;
  const stored = store.credentials.find((c) => c.credentialID === credentialID);
  if (!stored) {
    writeAudit({ ts: new Date().toISOString(), event: "auth_verify_fail", reason: "unknown_credential" });
    return NextResponse.json({ ok: false, reason: "unknown_credential" }, { status: 400 });
  }

  try {
    const credential: WebAuthnCredential = {
      id: stored.credentialID,
      publicKey: Buffer.from(stored.publicKey, "base64url"),
      counter: stored.counter,
      transports: stored.transports as WebAuthnCredential["transports"],
    };
    const verification = await verifyAuthenticationResponse({
      response: submitted,
      expectedChallenge: challenge,
      expectedOrigin: EXPECTED_ORIGINS,
      expectedRPID: RP_ID,
      credential,
      requireUserVerification: true,
    });

    if (!verification.verified) {
      writeAudit({ ts: new Date().toISOString(), event: "auth_verify_fail", reason: "verification_false" });
      return NextResponse.json({ ok: false, reason: "not_verified" }, { status: 400 });
    }

    // Update counter
    stored.counter = verification.authenticationInfo.newCounter;
    writeCredStore(store);

    const { token, expires_at } = mintIntentToken();
    writeAudit({ ts: new Date().toISOString(), event: "auth_verify_ok", details: { credId: stored.credentialID.slice(0, 12) } });
    return NextResponse.json({ ok: true, intent_token: token, expires_at });
  } catch (e) {
    writeAudit({ ts: new Date().toISOString(), event: "auth_verify_fail", reason: (e as Error).message });
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 400 });
  }
}
