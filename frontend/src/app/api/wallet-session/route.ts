import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  applyWalletCookie,
  clearChallengeCookie,
  clearWalletCookie,
  isWalletSessionCookieAllowed,
  readChallengeCookie,
  readWalletSessionCookie,
  verifyWalletChallenge,
} from "@/server/security/walletSession";
import { checkRateLimitProfile } from "@/server/security/rateLimit";

const claimSchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^0x[0-9a-fA-F]{6,}$|^G[A-Z2-7]{20,}$/, "Wallet does not match a known format."),
  family: z.enum(["evm", "stellar"]),
  nonce: z.string().trim().min(1).max(96),
  signature: z.string().trim().min(1).max(4096).optional(),
  signedTxXdr: z.string().trim().min(1).max(8192).optional(),
  network: z.string().trim().min(1).max(120).optional(),
});

function notConfigured() {
  return NextResponse.json(
    {
      error: "wallet_session_disabled",
      detail:
        "Set ALLOW_WALLET_SESSION_COOKIE=1 in this deployment to enable server-side wallet scoping for alert APIs.",
    },
    { status: 503 },
  );
}

export async function POST(request: NextRequest) {
  const rateLimited = checkRateLimitProfile(request, "alertRuleWrite");
  if (rateLimited) return rateLimited;

  if (!isWalletSessionCookieAllowed()) return notConfigured();

  const challenge = readChallengeCookie(request);
  if (!challenge) {
    return NextResponse.json(
      { error: "challenge_required", detail: "Request /api/wallet-session/nonce first to receive a wallet-ownership challenge." },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const wallet = parsed.data.walletAddress.trim().toLowerCase();
  if (parsed.data.nonce !== challenge.nonce) {
    const response = NextResponse.json({ error: "nonce_mismatch" }, { status: 401 });

    return clearChallengeCookie(response);
  }

  const result = await verifyWalletChallenge({
    challenge,
    walletAddress: wallet,
    family: parsed.data.family,
    signature: parsed.data.signature,
    signedTxXdr: parsed.data.signedTxXdr,
    network: parsed.data.network,
  });

  if (!result.ok) {
    const response = NextResponse.json({ error: "signature_invalid", detail: result.error }, { status: 401 });

    return clearChallengeCookie(response);
  }

  const response = NextResponse.json({ walletAddress: wallet, ttlSeconds: 60 * 60 * 12 });
  applyWalletCookie(response, wallet);
  clearChallengeCookie(response);

  return response;
}

export function GET(request: NextRequest) {
  const wallet = readWalletSessionCookie(request);

  if (!wallet) {
    return NextResponse.json({ walletAddress: null }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return NextResponse.json(
    { walletAddress: wallet },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: NextRequest) {
  const rateLimited = checkRateLimitProfile(request, "alertRuleWrite");
  if (rateLimited) return rateLimited;

  const response = NextResponse.json({ walletAddress: null });
  clearWalletCookie(response);
  clearChallengeCookie(response);

  return response;
}
