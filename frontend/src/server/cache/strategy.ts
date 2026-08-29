import { NextResponse } from "next/server";

export type ApiCacheKey =
  | "portfolio"
  | "news"
  | "social"
  | "onchain"
  | "decision"
  | "execution"
  | "history"
  | "scan"
  | "rules"
  | "transactions"
  | "alerts"
  | "alertRules";

export type ApiCachePolicy = {
  name: string;
  seconds: number;
  scope: "private" | "public" | "no-store";
  ttlClass: "short" | "medium" | "long" | "none";
  criticalFreshnessVisible: boolean;
  detail: string;
};

export const apiCacheStrategy: Record<ApiCacheKey, ApiCachePolicy> = {
  portfolio: {
    name: "portfolio-balances-short-ttl",
    seconds: 45,
    scope: "private",
    ttlClass: "short",
    criticalFreshnessVisible: true,
    detail: "Wallet portfolio snapshots can be reused briefly for the same user.",
  },
  news: {
    name: "news-public-long-ttl",
    seconds: 600,
    scope: "public",
    ttlClass: "long",
    criticalFreshnessVisible: true,
    detail: "RSS news data is cached for 10 minutes.",
  },
  social: {
    name: "social-public-long-ttl",
    seconds: 600,
    scope: "public",
    ttlClass: "long",
    criticalFreshnessVisible: true,
    detail: "Public metadata checks are cached for 10 minutes.",
  },
  onchain: {
    name: "security-flags-medium-ttl",
    seconds: 900,
    scope: "public",
    ttlClass: "medium",
    criticalFreshnessVisible: true,
    detail: "Onchain security and liquidity checks are cached for 15 minutes.",
  },
  decision: {
    name: "decision-no-store",
    seconds: 0,
    scope: "no-store",
    ttlClass: "none",
    criticalFreshnessVisible: true,
    detail: "Decision responses depend on submitted agent results.",
  },
  execution: {
    name: "execution-no-store",
    seconds: 0,
    scope: "no-store",
    ttlClass: "none",
    criticalFreshnessVisible: true,
    detail: "Execution planning and confirmation must never be shared-cacheable.",
  },
  history: {
    name: "history-no-store",
    seconds: 0,
    scope: "no-store",
    ttlClass: "none",
    criticalFreshnessVisible: false,
    detail: "History is wallet-specific and should be fetched fresh.",
  },
  scan: {
    name: "scan-no-store",
    seconds: 0,
    scope: "no-store",
    ttlClass: "none",
    criticalFreshnessVisible: true,
    detail: "Token scans combine live agent outputs and should be fetched fresh.",
  },
  rules: {
    name: "rules-no-store",
    seconds: 0,
    scope: "no-store",
    ttlClass: "none",
    criticalFreshnessVisible: false,
    detail: "User execution rules are wallet-specific and should be fetched fresh.",
  },
  alerts: {
    name: "alerts-no-store",
    seconds: 0,
    scope: "no-store",
    ttlClass: "none",
    criticalFreshnessVisible: true,
    detail: "Alert inboxes are wallet-specific and must never be shared-cached.",
  },
  alertRules: {
    name: "alert-rules-no-store",
    seconds: 0,
    scope: "no-store",
    ttlClass: "none",
    criticalFreshnessVisible: true,
    detail: "Alert rule definitions are wallet-specific and must never be shared-cached.",
  },
  transactions: {
    name: "transactions-no-store",
    seconds: 0,
    scope: "no-store",
    ttlClass: "none",
    criticalFreshnessVisible: false,
    detail: "Transactions are wallet-specific audit records and should be fetched fresh.",
  },
};

export function getCachePolicyMetadata(key: ApiCacheKey) {
  return apiCacheStrategy[key];
}

export function withCacheHeaders<T>(response: NextResponse<T>, key: ApiCacheKey) {
  const strategy = apiCacheStrategy[key];

  if (strategy.scope === "no-store") {
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  response.headers.set("Cache-Control", `${strategy.scope}, max-age=${strategy.seconds}, stale-while-revalidate=${strategy.seconds}`);

  return response;
}
