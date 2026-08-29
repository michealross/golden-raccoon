import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/server/security/rateLimit";
import { withCacheHeaders } from "@/server/cache/strategy";
import { listTransactionLifecycleEvents, listTransactionRecords } from "@/server/storage";
import { attachExplorerUrl } from "@/server/transactions/explorer";

export async function GET(request: NextRequest) {
  const rateLimited = checkRateLimit(request, { namespace: "history:transactions", limit: 80, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const walletAddress = request.nextUrl.searchParams.get("walletAddress") ?? undefined;
  const records = listTransactionRecords(walletAddress).map((record) => ({
    ...record,
    events: listTransactionLifecycleEvents(record.hash),
    explorerUrl: record.explorerUrl ?? attachExplorerUrl({ hash: record.hash, network: record.network, chainFamily: record.chainFamily }),
  }));

  return withCacheHeaders(NextResponse.json(records), "transactions");
}
