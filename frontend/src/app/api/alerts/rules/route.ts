import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withCacheHeaders } from "@/server/cache/strategy";
import { checkRateLimitProfile } from "@/server/security/rateLimit";
import { resolveWalletSession } from "@/server/security/walletSession";
import { deleteAlertRule, getAlertRule, listAlertRules, upsertAlertRule } from "@/server/storage";
import { ensureDefaultRulesForWallet } from "@/server/observability/alertIngestion";

const triggerTypeSchema = z.enum([
  "critical_risk",
  "liquidity_drop",
  "holder_concentration_change",
  "tax_control_change",
  "phishing_detected",
  "exploit_news",
  "portfolio_concentration",
  "stable_reserve_change",
  "stellar_issuer_auth",
  "stellar_clawback",
  "stellar_trustline",
  "stellar_contract_ttl",
  "rpc_degradation",
]);

const severitySchema = z.enum(["low", "medium", "high", "critical"]);
const directionSchema = z.enum(["high_is_bad", "low_is_bad"]).optional();

const ruleSchema = z.object({
  // The session wallet is authoritative; the body field is validated for
  // shape only and must match the session wallet on its own.
  walletAddress: z.string().min(1),
  triggerType: triggerTypeSchema,
  observationKey: z.string().min(1).max(160).optional(),
  threshold: z.number(),
  hysteresis: z.number().min(0).default(0),
  cooldownMinutes: z.number().min(0).max(24 * 60).default(60),
  direction: directionSchema,
  severity: severitySchema.default("medium"),
  enabled: z.boolean().default(true),
});

export function GET(request: NextRequest) {
  const rateLimited = checkRateLimitProfile(request, "alertRead");
  if (rateLimited) return rateLimited;

  const url = new URL(request.url);
  const session = resolveWalletSession(request, {
    suppliedWallet: url.searchParams.get("walletAddress"),
  });
  if (session.response) return session.response;
  const wallet = session.wallet!;

  ensureDefaultRulesForWallet(wallet);

  return withCacheHeaders(
    NextResponse.json(listAlertRules(wallet)),
    "alertRules",
  );
}

export async function POST(request: NextRequest) {
  const rateLimited = checkRateLimitProfile(request, "alertRuleWrite");
  if (rateLimited) return rateLimited;

  const body = await request.json().catch(() => ({}));
  const parsed = ruleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const session = resolveWalletSession(request, { suppliedWallet: parsed.data.walletAddress });
  if (session.response) return session.response;
  const wallet = session.wallet!;

  ensureDefaultRulesForWallet(wallet);
  const existingForKey = parsed.data.observationKey
    ? listAlertRules(wallet).find(
        (rule) => rule.triggerType === parsed.data.triggerType && rule.observationKey === parsed.data.observationKey,
      )
    : undefined;
  const record = upsertAlertRule({
    id: existingForKey?.id ?? `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    walletAddress: wallet,
    triggerType: parsed.data.triggerType,
    observationKey: parsed.data.observationKey,
    threshold: parsed.data.threshold,
    hysteresis: parsed.data.hysteresis,
    cooldownMinutes: parsed.data.cooldownMinutes,
    direction: parsed.data.direction ?? "high_is_bad",
    severity: parsed.data.severity,
    enabled: parsed.data.enabled,
    createdAt: existingForKey?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return withCacheHeaders(NextResponse.json(record), "alertRules");
}

export async function DELETE(request: NextRequest) {
  const rateLimited = checkRateLimitProfile(request, "alertRuleWrite");
  if (rateLimited) return rateLimited;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const session = resolveWalletSession(request, {
    suppliedWallet: url.searchParams.get("walletAddress"),
  });
  if (session.response) return session.response;
  const wallet = session.wallet!;

  if (!id) {
    return NextResponse.json({ error: "id query parameter is required" }, { status: 400 });
  }

  const rule = getAlertRule(id);
  if (!rule) {
    return NextResponse.json({ error: "rule not found" }, { status: 404 });
  }
  if (rule.walletAddress !== wallet) {
    return NextResponse.json({ error: "rule does not belong to this wallet" }, { status: 403 });
  }

  return withCacheHeaders(
    NextResponse.json({ deleted: deleteAlertRule(id, wallet) }),
    "alertRules",
  );
}
