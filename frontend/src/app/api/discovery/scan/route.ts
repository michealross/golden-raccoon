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
  pairUrl: z.string().url().optional(),
  symbol: z.string().max(32).optional(),
  tokenName: z.string().max(120).optional(),
  assetKey: z.string().max(180).optional(),
  issuer: z.string().max(64).optional(),
  assetType: z.enum(["native", "classic", "contract", "issuer_account"]).optional(),
  source: z.enum(["dexscreener", "stellar_market", "manual"]).default("manual"),
  sourceUrl: z.string().url().optional(),
  discoveredAt: z.string().datetime().optional(),
  metrics: z.object({
    liquidityUsd: z.number().min(0).optional(),
    volume24hUsd: z.number().min(0).optional(),
    fdvUsd: z.number().min(0).optional(),
    fdvLiquidityRatio: z.number().min(0).optional(),
    priceChange24hPercent: z.number().optional(),
    pairAgeDays: z.number().min(0).optional(),
  }).optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
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

  const rateLimited = checkRateLimit(request, { namespace: "discovery:scan", limit: 20, windowMs: 60_000 });

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
        pairUrl: parsed.data.candidate.pairUrl,
        symbol: parsed.data.candidate.symbol,
        tokenName: parsed.data.candidate.tokenName,
        assetKey: parsed.data.candidate.assetKey,
        issuer: parsed.data.candidate.issuer,
        assetType: parsed.data.candidate.assetType,
        source: parsed.data.candidate.source,
        sourceUrl: parsed.data.candidate.sourceUrl,
        discoveredAt: parsed.data.candidate.discoveredAt ?? new Date().toISOString(),
        metrics: parsed.data.candidate.metrics ?? {},
        raw: parsed.data.candidate.raw ?? {},
      },
      { walletAddress: parsed.data.walletAddress },
    );

    return NextResponse.json({
      scan: {
        ...scan,
        results: scan.results,
        decision: scan.decision,
        sourceLineage: scan.sourceLineage,
        missingData: scan.missingData,
        classification: scan.classification,
        classificationReasons: scan.classificationReasons,
        confidence: scan.confidence,
        candidate: scan.candidate,
        identity: scan.identity,
        scannedAt: scan.scannedAt,
      },
      executionGuarantees: {
        serverCanSign: false,
        autoExecute: false,
        transactionPrepared: false,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Discovery scan failed" }, { status: 500 });
  }
}
