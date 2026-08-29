import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeStellarNetworkId } from "@/lib/stellar/config";
import { isStellarAccountAddress } from "@/lib/chainIdentity";
import { prepareRiskPublication } from "@/server/stellar/riskRegistry";
import { checkRateLimit } from "@/server/security/rateLimit";

const bodySchema = z.object({
  network: z.string(), publisher: z.string().refine(isStellarAccountAddress, "Expected Stellar G-address"),
  assetKey: z.string().min(1).max(180), assetLabel: z.string().min(1).max(180),
  score: z.number().int().min(0).max(100), confidenceBps: z.number().int().min(0).max(10000).default(5000),
  verdict: z.string().regex(/^[a-zA-Z0-9_]{1,32}$/),
  evidenceUri: z.string().max(512).default(""), updatedAt: z.number().int().positive().optional(), report: z.unknown(),
});

export async function POST(request: Request) {
  const limited = checkRateLimit(request, { namespace: "stellar:registry:prepare", limit: 15, windowMs: 60_000 });
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const network = normalizeStellarNetworkId(parsed.data.network);
  if (!network) return NextResponse.json({ error: "Unsupported Stellar network" }, { status: 400 });
  try {
    return NextResponse.json(await prepareRiskPublication(network, {
      ...parsed.data,
      report: parsed.data.report ?? {},
      updatedAt: parsed.data.updatedAt ?? Math.floor(Date.now() / 1000),
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not prepare registry transaction" }, { status: 502 });
  }
}
