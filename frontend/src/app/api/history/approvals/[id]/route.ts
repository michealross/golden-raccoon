import type { AgentRecommendedAction } from "@/server/types";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withCacheHeaders } from "@/server/cache/strategy";
import { checkRateLimit } from "@/server/security/rateLimit";
import { createTransactionRecord, getTransactionRecord, listApprovalRecords } from "@/server/storage";

const statusSchema = z.enum([
  "prepared",
  "user_rejected",
  "submitted",
  "confirmed",
  "failed",
  "replaced",
  "expired",
  "pending",
]);

const bodySchema = z.object({
  status: statusSchema,
  txHash: z.string().optional(),
  reason: z.string().optional(),
  // Stellar-specific fields for status updates
  stellarSequenceNumber: z.string().optional(),
  stellarFeeCharged: z.number().optional(),
  stellarOperationCount: z.number().optional(),
  stellarLedger: z.number().optional(),
  stellarResultXdr: z.string().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const rateLimited = checkRateLimit(request, { namespace: `approvals:${id}`, limit: 20, windowMs: 60_000 });
  if (rateLimited) {
    return rateLimited;
  }

  const body = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Find the existing transaction record or approval record
  const existingApproval = findApprovalRecord(id);

  if (!existingApproval) {
    return NextResponse.json({ error: "approval_not_found", detail: `No approval record found with id: ${id}` }, { status: 404 });
  }

  // Build the updated status record
  const txHash = parsed.data.txHash ?? existingApproval.txHash;
  const status = parsed.data.status;

  // If the transaction hash isn't recorded yet, create a transaction record
  if (parsed.data.txHash && !getTransactionRecord(parsed.data.txHash)) {
    const isStellar = status === "submitted" || status === "confirmed" || status === "failed";
    createTransactionRecord({
      hash: parsed.data.txHash,
      type: existingApproval.action === "create_trustline" ? "trustline_create" : "approval",
      decisionAction: existingApproval.action as AgentRecommendedAction | undefined,
      asset: existingApproval.asset ?? "Approval update",
      valueUsd: existingApproval.valueUsd ?? 0,
      status: status === "confirmed" ? "confirmed" : "submitted",
      network: existingApproval.network,
      walletAddress: existingApproval.walletAddress,
      userApproved: true,
      decisionId: existingApproval.decisionId,
      stellarDetails: isStellar ? {
        sequence: parsed.data.stellarSequenceNumber,
        feeCharged: parsed.data.stellarFeeCharged,
        operationCount: parsed.data.stellarOperationCount,
        ledger: parsed.data.stellarLedger,
        resultXdr: parsed.data.stellarResultXdr,
      } : undefined,
    });
  }

  // Update the existing transaction record if hash matches
  const existingTx = parsed.data.txHash ? getTransactionRecord(parsed.data.txHash) : undefined;
  if (existingTx) {
    createTransactionRecord({
      ...existingTx,
      status: status === "confirmed" ? "confirmed"
        : status === "failed" ? "failed"
        : status === "user_rejected" ? "user_rejected"
        : status === "replaced" ? "replaced"
        : status === "expired" ? "expired"
        : existingTx.status,
    });
  }

  return withCacheHeaders(NextResponse.json({
    id,
    status,
    previousStatus: existingApproval.status,
    updatedAt: new Date().toISOString(),
    reason: parsed.data.reason,
    transactionHash: txHash,
  }), "history");
}

// Find an approval record by id using the storage API
function findApprovalRecord(id: string): {
  id: string;
  walletAddress: string;
  decisionId?: string;
  txHash: string;
  network?: string;
  action?: string;
  asset?: string;
  valueUsd?: number;
  status: string;
  createdAt: string;
} | null {
  const records = listApprovalRecords();
  const found = records.find((record) => record.id === id);
  if (!found) return null;

  return {
    id: found.id,
    walletAddress: found.walletAddress,
    decisionId: found.decisionId,
    txHash: found.txHash,
    network: found.network,
    action: found.action,
    asset: found.asset,
    valueUsd: found.valueUsd,
    status: found.status,
    createdAt: found.createdAt,
  };
}
