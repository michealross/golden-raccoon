import { NextResponse } from "next/server";
import { z } from "zod";
import { withCacheHeaders } from "@/server/cache/strategy";
import { assertApprovalOnly } from "@/server/security/policy";
import { checkRateLimit } from "@/server/security/rateLimit";
import { createApprovalRecord, createTransactionRecord, getTransactionRecord } from "@/server/storage";
import { getChainFamily, isTransactionHashForChain } from "@/lib/chainIdentity";
import { createStellarRpcServer } from "@/server/stellar/client";

/**
 * Confirm a Stellar transaction exists on-chain via RPC before persisting.
 */
async function confirmStellarTransactionOnChain(hash: string, network: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { server } = createStellarRpcServer(network);
    const txResponse = await server.getTransaction(hash);

    if (!txResponse) {
      return { ok: false, detail: "Transaction not found on Stellar network." };
    }

    if (txResponse.status === "NOT_FOUND") {
      return { ok: false, detail: "Transaction has not yet been included in a Stellar ledger." };
    }

    if (txResponse.status === "FAILED") {
      return { ok: false, detail: "Transaction failed on the Stellar network." };
    }

    return {
      ok: true,
      detail: `Transaction confirmed on Stellar ledger ${txResponse.ledger}.`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "Stellar RPC confirmation check failed.",
    };
  }
}

const bodySchema = z.object({
  decisionId: z.string().optional(),
  walletAddress: z.string().min(1),
  decisionWalletAddress: z.string().optional(),
  txHash: z.string().min(1),
  userApproved: z.literal(true),
  network: z.string().optional(),
  action: z.enum(["hold", "watch", "reduce_exposure", "swap_to_stable", "avoid", "manual_review", "prepare_transaction", "create_trustline", "no_action"]).optional(),
  asset: z.string().optional(),
  valueUsd: z.number().min(0).optional(),
  riskScore: z.number().min(0).max(100).optional(),
  simulationStatus: z.enum(["not_required", "pending", "passed", "failed", "unavailable"]).optional(),
  policyAllowed: z.boolean().optional(),
  policyViolations: z.array(z.string()).optional(),
  // Stellar-specific confirmation fields
  stellarSequenceNumber: z.string().optional(),
  stellarFeeCharged: z.number().optional(),
  stellarOperationCount: z.number().optional(),
  stellarLedger: z.number().optional(),
  stellarEnvelopeXdr: z.string().optional(),
  stellarResultXdr: z.string().optional(),
  stellarTrustlineAsset: z.string().optional(),
});

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, { namespace: "execute:confirm", limit: 20, windowMs: 60_000 });

  if (rateLimited) {
    return rateLimited;
  }

  const body = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Validate transaction hash format based on network chain family
  const chainFamily = getChainFamily(parsed.data.network);

  if (!isTransactionHashForChain(parsed.data.txHash, chainFamily)) {
    return NextResponse.json({
      error: "invalid_tx_hash",
      detail: `Transaction hash does not match expected format for ${chainFamily} chain. Stellar hashes are 64 hex chars; EVM hashes are 0x-prefixed 64 hex chars.`,
    }, { status: 400 });
  }

  try {
    assertApprovalOnly({ userApproved: parsed.data.userApproved, autoExecute: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Execution policy failed" }, { status: 403 });
  }

  if (parsed.data.simulationStatus === "failed") {
    return NextResponse.json({ error: "simulation_failed", detail: "Simulation failed. Confirmation is blocked." }, { status: 403 });
  }

  if (parsed.data.policyAllowed === false) {
    return NextResponse.json({ error: "policy_violation", detail: parsed.data.policyViolations ?? [] }, { status: 403 });
  }

  // Verify signing account matches decision account for Stellar
  const isStellar = getChainFamily(parsed.data.network) === "stellar";
  if (isStellar && parsed.data.decisionWalletAddress && parsed.data.decisionWalletAddress.toUpperCase() !== parsed.data.walletAddress.toUpperCase()) {
    return NextResponse.json({ error: "wallet_mismatch", detail: "Connected Stellar wallet does not match the decision wallet." }, { status: 403 });
  }

  if (parsed.data.decisionWalletAddress && !isStellar && parsed.data.decisionWalletAddress.toLowerCase() !== parsed.data.walletAddress.toLowerCase()) {
    return NextResponse.json({ error: "wallet_mismatch", detail: "Connected wallet does not match the decision wallet." }, { status: 403 });
  }

  const highRiskTrade = (parsed.data.action === "reduce_exposure" || parsed.data.action === "swap_to_stable" || parsed.data.action === "prepare_transaction") && (parsed.data.riskScore ?? 0) >= 50;

  if (highRiskTrade && parsed.data.simulationStatus !== "passed") {
    return NextResponse.json({ error: "simulation_required", detail: "High-risk execution confirmation requires a fresh passed simulation." }, { status: 403 });
  }

  if (getTransactionRecord(parsed.data.txHash)) {
    return NextResponse.json({ error: "duplicate_tx_hash", detail: "This transaction hash is already recorded." }, { status: 409 });
  }

  // Confirm through RPC before persistence (Stellar)
  if (isStellar && parsed.data.network) {
    const onChainConfirmation = await confirmStellarTransactionOnChain(parsed.data.txHash, parsed.data.network);

    if (!onChainConfirmation.ok) {
      return NextResponse.json({
        error: "stellar_rpc_confirmation_failed",
        detail: onChainConfirmation.detail,
      }, { status: 422 });
    }
  }

  const approval = createApprovalRecord({
    walletAddress: parsed.data.walletAddress,
    decisionId: parsed.data.decisionId,
    txHash: parsed.data.txHash,
    network: parsed.data.network ?? "Connected wallet",
    action: parsed.data.action,
    asset: parsed.data.asset ?? "Wallet approval",
    valueUsd: parsed.data.valueUsd ?? 0,
  });
  const txType = parsed.data.action === "create_trustline"
    ? "trustline_create"
    : parsed.data.action === "reduce_exposure" || parsed.data.action === "swap_to_stable" || parsed.data.action === "prepare_transaction"
      ? "swap"
      : "approval";

  const transaction = createTransactionRecord({
    hash: parsed.data.txHash,
    type: txType,
    decisionAction: parsed.data.action,
    asset: parsed.data.asset ?? "Wallet approval",
    valueUsd: parsed.data.valueUsd ?? 0,
    status: "confirmed",
    network: parsed.data.network ?? "Connected wallet",
    walletAddress: parsed.data.walletAddress,
    userApproved: true,
    decisionId: parsed.data.decisionId,
    simulationStatus: parsed.data.simulationStatus,
    policyStatus: {
      allowed: parsed.data.policyAllowed ?? true,
      violations: parsed.data.policyViolations ?? [],
    },
    stellarDetails: isStellar ? {
      sequence: parsed.data.stellarSequenceNumber,
      feeCharged: parsed.data.stellarFeeCharged,
      operationCount: parsed.data.stellarOperationCount,
      ledger: parsed.data.stellarLedger,
      envelopeXdr: parsed.data.stellarEnvelopeXdr,
      resultXdr: parsed.data.stellarResultXdr,
      trustlineAsset: parsed.data.stellarTrustlineAsset,
    } : undefined,
  });

  return withCacheHeaders(NextResponse.json({
    ...parsed.data,
    status: "confirmed",
    autoExecuted: false,
    approval,
    transaction,
    confirmedAt: new Date().toISOString(),
  }), "execution");
}
