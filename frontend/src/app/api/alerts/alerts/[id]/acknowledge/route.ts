import { NextResponse } from "next/server";
import { z } from "zod";
import { withCacheHeaders } from "@/server/cache/strategy";
import { checkRateLimitProfile } from "@/server/security/rateLimit";
import { resolveWalletSession } from "@/server/security/walletSession";
import { updateAlert, getAlert, createAlertDelivery, updateAlertDelivery } from "@/server/storage";
import { buildSanitizedAlertPayload } from "@/server/observability/alertSanitize";

const bodySchema = z
  .object({
    // Wallet is informational; the cookie-derived session wallet is the
    // authoritative scope used for both lookup and update.
    walletAddress: z.string().min(1).optional(),
  })
  .passthrough();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const rateLimited = checkRateLimitProfile(request as unknown as import("next/server").NextRequest, "alertAcknowledge");
  if (rateLimited) return rateLimited;

  const params = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const session = resolveWalletSession(request as unknown as import("next/server").NextRequest, {
    suppliedWallet: parsed.data.walletAddress,
  });
  if (session.response) return session.response;
  const wallet = session.wallet!;

  const alert = getAlert(params.id, wallet);
  if (!alert) {
    return NextResponse.json({ error: "alert not found for wallet" }, { status: 404 });
  }

  if (alert.status === "acknowledged") {
    return withCacheHeaders(NextResponse.json(alert), "alerts");
  }
  if (alert.status === "recovered") {
    return withCacheHeaders(NextResponse.json({ error: "Alert already recovered" }, { status: 409 }), "alerts");
  }

  const acknowledgedAt = new Date().toISOString();
  const updated = updateAlert(alert.id, wallet, { status: "acknowledged", acknowledgedAt });
  if (!updated) {
    return NextResponse.json({ error: "alert could not be updated" }, { status: 500 });
  }

  const sanitized = buildSanitizedAlertPayload(updated, undefined, { walletAddressHint: wallet });
  const delivery = createAlertDelivery({
    alertId: updated.id,
    walletAddress: wallet,
    channel: "in_app",
    status: "delivered",
    sanitizedPayload: { ...sanitized, summary: `Acknowledged: ${sanitized.summary}` },
    attemptCount: 1,
    sentAt: acknowledgedAt,
  });
  updateAlertDelivery(delivery.id, wallet, { sentAt: acknowledgedAt });

  return withCacheHeaders(NextResponse.json(updated), "alerts");
}
