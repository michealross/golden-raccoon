import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/server/security/rateLimit";
import { withCacheHeaders } from "@/server/cache/strategy";
import { getTransactionRecord, listTransactionLifecycleEvents } from "@/server/storage";
import { pollTransaction } from "@/server/transactions/lifecycleManager";
import { attachExplorerUrl } from "@/server/transactions/explorer";

const querySchema = z.object({
  network: z.string().optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ hash: string }> }) {
  const rateLimited = checkRateLimit(request, { namespace: "execute:transaction-status", limit: 120, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const { hash } = await params;
  const parameters = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));

  if (!parameters.success) {
    return NextResponse.json({ error: parameters.error.flatten() }, { status: 400 });
  }

  const record = getTransactionRecord(hash);
  if (!record) {
    return NextResponse.json({ error: "transaction_not_found", detail: `No transaction record found for hash ${hash}.` }, { status: 404 });
  }

  const poll = await pollTransaction(hash, { network: parameters.data.network });

  const explorerUrl = attachExplorerUrl({ hash: poll.transaction.hash, network: poll.transaction.network, chainFamily: poll.transaction.chainFamily });

  return withCacheHeaders(NextResponse.json({
    transaction: { ...poll.transaction, explorerUrl: poll.transaction.explorerUrl ?? explorerUrl },
    polled: poll.polled,
    terminalReached: poll.terminalReached,
    events: poll.events,
  }), "transactions");
}
