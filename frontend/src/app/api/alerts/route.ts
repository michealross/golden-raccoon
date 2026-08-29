import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/server/security/rateLimit";
import { acknowledgeDiscoveryAlert, listDiscoveryAlerts } from "@/server/storage";

const acknowledgeSchema = z.object({
  action: z.literal("acknowledge"),
  alertId: z.string().min(1).max(120),
});

const listQuerySchema = z.object({
  walletAddress: z.string().min(1).max(80),
});

export async function GET(request: Request) {
  const rateLimited = checkRateLimit(request, { namespace: "alerts:list", limit: 60, windowMs: 60_000 });

  if (rateLimited) {
    return rateLimited;
  }

  const url = new URL(request.url);
  const parsed = listQuerySchema.safeParse({ walletAddress: url.searchParams.get("walletAddress") ?? "" });

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  return NextResponse.json({ alerts: listDiscoveryAlerts(parsed.data.walletAddress) });
}

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, { namespace: "alerts:ack", limit: 30, windowMs: 60_000 });

  if (rateLimited) {
    return rateLimited;
  }

  const body = await request.json().catch(() => ({}));
  const parsed = acknowledgeSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const alert = acknowledgeDiscoveryAlert(parsed.data.alertId);

  if (!alert) {
    return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  }

  return NextResponse.json({ alert });
}
