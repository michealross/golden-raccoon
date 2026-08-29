import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withCacheHeaders } from "@/server/cache/strategy";
import { checkRateLimitProfile } from "@/server/security/rateLimit";
import { resolveWalletSession } from "@/server/security/walletSession";
import { listAlertObservations } from "@/server/storage";

const querySchema = z.object({
  walletAddress: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).optional(),
});

export function GET(request: NextRequest) {
  const rateLimited = checkRateLimitProfile(request, "alertRead");
  if (rateLimited) return rateLimited;

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    walletAddress: url.searchParams.get("walletAddress") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const session = resolveWalletSession(request, { suppliedWallet: parsed.data.walletAddress });
  if (session.response) return session.response;
  const wallet = session.wallet!;

  return withCacheHeaders(
    NextResponse.json(listAlertObservations(wallet, parsed.data.limit ?? 100)),
    "alerts",
  );
}
