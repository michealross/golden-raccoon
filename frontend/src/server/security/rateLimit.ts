import { NextRequest, NextResponse } from "next/server";

type RateLimitOptions = {
  limit: number;
  windowMs: number;
  namespace: string;
};

export const rateLimitProfiles = {
  tokenScan: { namespace: "scan:token", limit: 25, windowMs: 60_000 },
  portfolioReview: { namespace: "agent:portfolio", limit: 30, windowMs: 60_000 },
  executionPrepare: { namespace: "execute:prepare", limit: 20, windowMs: 60_000 },
  historyRead: { namespace: "history", limit: 80, windowMs: 60_000 },
  expensiveProviderCall: { namespace: "provider:expensive", limit: 10, windowMs: 60_000 },
  alertRead: { namespace: "alert:read", limit: 80, windowMs: 60_000 },
  alertRuleWrite: { namespace: "alert:write", limit: 30, windowMs: 60_000 },
  alertAcknowledge: { namespace: "alert:ack", limit: 30, windowMs: 60_000 },
} satisfies Record<string, RateLimitOptions>;

const buckets = globalThis as typeof globalThis & {
  __goldenRaccoonRateLimit?: Map<string, { count: number; resetAt: number }>;
};

function getBuckets() {
  buckets.__goldenRaccoonRateLimit ??= new Map();

  return buckets.__goldenRaccoonRateLimit;
}

export function getClientKey(request: Request | NextRequest, namespace: string) {
  const headers = request.headers;
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = headers.get("x-real-ip");

  return `${namespace}:${forwardedFor || realIp || "local"}`;
}

export function checkRateLimit(request: Request | NextRequest, options: RateLimitOptions) {
  const key = getClientKey(request, options.namespace);
  const now = Date.now();
  const bucket = getBuckets().get(key);

  if (!bucket || bucket.resetAt <= now) {
    getBuckets().set(key, { count: 1, resetAt: now + options.windowMs });
    return null;
  }

  if (bucket.count >= options.limit) {
    const response = NextResponse.json(
      {
        error: "rate_limited",
        detail: `Too many ${options.namespace} requests. Try again after ${new Date(bucket.resetAt).toISOString()}.`,
      },
      { status: 429 },
    );

    response.headers.set("Retry-After", Math.ceil((bucket.resetAt - now) / 1000).toString());

    return response;
  }

  bucket.count += 1;

  return null;
}

export function checkRateLimitProfile(request: Request | NextRequest, profile: keyof typeof rateLimitProfiles) {
  return checkRateLimit(request, rateLimitProfiles[profile]);
}
