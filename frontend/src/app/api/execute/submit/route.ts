import { NextResponse } from "next/server";
import { z } from "zod";
import { isWalletAddressForChain, isStellarAccountAddress, canonicalizeAddress, getChainFamily } from "@/lib/chainIdentity";
import { withCacheHeaders } from "@/server/cache/strategy";
import { checkRateLimit } from "@/server/security/rateLimit";
import { submitTransaction } from "@/server/transactions/lifecycleManager";

const bodySchema = z.object({
  chainFamily: z.enum(["evm", "stellar"]),
  network: z.string().min(1).max(64),
  walletAddress: z.string().min(1),
  sourceAccount: z.string().optional(),
  signedPayload: z.string().min(10).max(200_000),
  decisionId: z.string().optional(),
  decisionAction: z.enum(["hold", "watch", "reduce_exposure", "swap_to_stable", "avoid", "manual_review", "prepare_transaction", "no_action"]).optional(),
  asset: z.string().min(1).max(80),
  valueUsd: z.number().min(0).optional(),
  simulationStatus: z.enum(["not_required", "pending", "passed", "failed", "unavailable"]).optional(),
  policyStatus: z.object({ allowed: z.boolean(), violations: z.array(z.string()) }).optional(),
  expectedEffects: z.array(z.object({
    kind: z.enum(["transfer", "swap", "approval", "contract_call", "publish_risk"]),
    fromToken: z.string().optional(),
    toToken: z.string().optional(),
    fromAddress: z.string().optional(),
    toAddress: z.string().optional(),
    amount: z.string().optional(),
    contractAddress: z.string().optional(),
    method: z.string().optional(),
    assetKey: z.string().optional(),
  })).optional(),
  idempotencyKey: z.string().min(1).max(160).optional(),
});

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, { namespace: "execute:submit", limit: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const body = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const walletFamily = getChainFamily(parsed.data.network);
  if (parsed.data.chainFamily !== walletFamily) {
    return NextResponse.json({ error: "chain_family_mismatch", detail: `Network ${parsed.data.network} belongs to ${walletFamily} but family ${parsed.data.chainFamily} was supplied.` }, { status: 400 });
  }

  const walletValid = parsed.data.chainFamily === "stellar" ? isStellarAccountAddress(parsed.data.walletAddress) : isWalletAddressForChain(parsed.data.walletAddress, "evm");
  if (!walletValid) {
    return NextResponse.json({ error: "invalid_wallet", detail: `Wallet address does not match ${parsed.data.chainFamily} format.` }, { status: 400 });
  }

  if (parsed.data.sourceAccount && parsed.data.chainFamily === "stellar" && !isStellarAccountAddress(parsed.data.sourceAccount)) {
    return NextResponse.json({ error: "invalid_source", detail: "Stellar source account must be a valid G-address." }, { status: 400 });
  }

  if (parsed.data.sourceAccount && parsed.data.chainFamily === "evm" && canonicalizeAddress(parsed.data.sourceAccount, "evm") !== canonicalizeAddress(parsed.data.walletAddress, "evm")) {
    return NextResponse.json({ error: "source_wallet_mismatch", detail: "EVM source account must equal the connected wallet." }, { status: 403 });
  }

  try {
    const report = await submitTransaction({
      chainFamily: parsed.data.chainFamily,
      network: parsed.data.network,
      walletAddress: parsed.data.walletAddress,
      sourceAccount: parsed.data.sourceAccount,
      decisionId: parsed.data.decisionId,
      decisionAction: parsed.data.decisionAction,
      asset: parsed.data.asset,
      valueUsd: parsed.data.valueUsd,
      simulationStatus: parsed.data.simulationStatus,
      policyStatus: parsed.data.policyStatus,
      expectedEffects: parsed.data.expectedEffects,
      userApproved: true,
      signedPayload: parsed.data.signedPayload,
      idempotencyKey: parsed.data.idempotencyKey,
    });

    return withCacheHeaders(NextResponse.json({
      success: true,
      outcome: report.outcome,
      ...report.result,
      transaction: report.transaction,
    }), "execution");
  } catch (error) {
    const code = (error as { code?: string }).code ?? "submit_failed";
    const status = code === "approval_required" ? 403
      : code === "hash_chain_family_mismatch" || code === "network_chain_family_mismatch" ? 400
      : code === "transaction_not_found" ? 404
      : 502;
    return NextResponse.json({
      error: code,
      detail: error instanceof Error ? error.message : "Could not submit transaction.",
      ...(error && typeof error === "object" && "detail" in error ? { extra: (error as { detail?: unknown }).detail } : {}),
    }, { status });
  }
}
