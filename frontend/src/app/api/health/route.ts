import { NextResponse } from "next/server";
import { apiCacheStrategy } from "@/server/cache/strategy";
import { getAgentReadiness, getEnvHealth } from "@/server/env/validation";
import { getRuntimeModeHealth } from "@/server/env/runtimeMode";
import { getSecurityHealth } from "@/server/security/policy";
import { getStorageCounts, getStorageHealth, listAgentRunRecords, listAlerts } from "@/server/storage";
import { getProductionHealth } from "@/server/observability/health";
import { getAgentRunMetrics } from "@/server/observability/metrics";
import { alertThresholds, evaluateAlertThresholds } from "@/server/observability/alerts";

export const dynamic = "force-dynamic";

export function GET() {
  const metrics = getAgentRunMetrics(listAgentRunRecords());
  const triggeredCount = listAlerts(undefined, "triggered").length;
  const recoveredCount = listAlerts(undefined, "recovered").length;
  const acknowledgedCount = listAlerts(undefined, "acknowledged").length;
  return NextResponse.json(
    {
      ok: true,
      service: "golden-raccoon",
      env: getEnvHealth(),
      agentReadiness: getAgentReadiness(),
      storage: getStorageHealth(),
      storageCounts: getStorageCounts(),
      security: getSecurityHealth(),
      productionHealth: getProductionHealth(),
      metrics,
      alerts: {
        thresholds: alertThresholds,
        status: evaluateAlertThresholds(metrics),
        engine: {
          triggered: triggeredCount,
          recovered: recoveredCount,
          acknowledged: acknowledgedCount,
          total: triggeredCount + recoveredCount + acknowledgedCount,
        },
      },
      runtimeMode: getRuntimeModeHealth(),
      cache: apiCacheStrategy,
      mockFallbacksEnabled: false,
      liveModeUsesMockData: false,
      professionalRiskLanguage: true,
      checkedAt: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
