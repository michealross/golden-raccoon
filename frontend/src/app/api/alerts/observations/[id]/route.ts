import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkRateLimitProfile } from "@/server/security/rateLimit";
import { resolveWalletSession } from "@/server/security/walletSession";
import { listAlertObservations } from "@/server/storage";

export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const rateLimited = checkRateLimitProfile(request, "alertRead");
  if (rateLimited) return rateLimited;

  return (async () => {
    const params = await context.params;
    const url = new URL(request.url);
    const session = resolveWalletSession(request, { suppliedWallet: url.searchParams.get("walletAddress") ?? undefined });
    if (session.response) return session.response;
    const wallet = session.wallet!;
    const observation = listAlertObservations(wallet, 500).find((entry) => entry.id === params.id);

    if (!observation) {
      return NextResponse.json({ error: "observation not found for wallet" }, { status: 404 });
    }

    return NextResponse.json(observation, { headers: { "Cache-Control": "no-store" } });
  })();
}
