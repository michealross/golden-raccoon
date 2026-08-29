import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/server/security/rateLimit";
import { scanDiscoveryCandidate } from "@/server/discovery/pipeline";
import { assertApprovalOnly } from "@/server/security/policy";

const discoveryCandidateSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  chain: z.string().min(1).max(40),
  contractAddress: z.string().max(80).optional(),
  pairAddress: z.string().max(120).optional(),
  symbol: z.string().max(32).optional(),
  tokenName: z.string().max(120).optional(),
  assetKey: z.string().max(180).optional(),
  issuer: z.string().max(64).optional(),
  assetType: z.enum(["native", "classic", "contract", "issuer_account"]).optional(),
  source: z.enum(["dexscreener", "stellar_market", "manual"]).default("manual"),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const bodySchema = z.object({
  candidate: discoveryCandidateSchema,
  walletAddress: z.string().max(80).optional(),
});

export async function POST(request: Request) {
  try {
    assertApprovalOnly({ autoExecute: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Auto-execute policy blocked." }, { status: 403 });
  }

  const rateLimited = checkRateLimit(request, { namespace: "discovery:classify", limit: 25, windowMs: 60_000 });

  if (rateLimited) {
    return rateLimited;
  }

  const body = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const scan = await scanDiscoveryCandidate(
      {
        id: parsed.data.candidate.id ?? `candidate_${Date.now().toString(36)}`,
        chain: parsed.data.candidate.chain,
        contractAddress: parsed.data.candidate.contractAddress,
        pairAddress: parsed.data.candidate.pairAddress,
        symbol: parsed.data.candidate.symbol,
        tokenName: parsed.data.candidate.tokenName,
        assetKey: parsed.data.candidate.assetKey,
        issuer: parsed.data.candidate.issuer,
        assetType: parsed.data.candidate.assetType,
        source: parsed.data.candidate.source,
        discoveredAt: new Date().toISOString(),
        metrics: parsed.data.candidate.metrics ?? {},
        raw: {},
      },
      { walletAddress: parsed.data.walletAddress },
    );

    return NextResponse.json({
      classification: scan.classification,
      classificationReasons: scan.classificationReasons,
      confidence: scan.confidence,
      identityConfidence: scan.identity.confidence,
      identityConfidenceLabel: scan.identity.confidenceLabel,
      identityKey: scan.identity.identityKey,
      sourceCoverage: scan.sourceLineage.length,
      missingData: scan.missingData,
      executionGuarantees: {
        serverCanSign: false,
        autoExecute: false,
        transactionPrepared: false,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Classify failed" }, { status: 500 });
  }
}
