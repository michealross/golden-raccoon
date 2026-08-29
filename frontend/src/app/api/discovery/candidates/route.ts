import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/server/security/rateLimit";
import { listDiscoveryCandidates } from "@/server/discovery/pipeline";
import { fetchLiveDiscoveryCandidates, isOfflineSnapshot } from "@/server/discovery/sources";

const bodySchema = z.object({
  chain: z.string().min(1).max(64).optional(),
  provider: z.enum(["dexscreener", "stellar_market", "manual"]).default("manual"),
});

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, { namespace: "discovery:candidates", limit: 30, windowMs: 60_000 });

  if (rateLimited) {
    return rateLimited;
  }

  const body = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const candidates = await listDiscoveryCandidates(parsed.data.chain, {
    listCandidates: async (chain) => {
      const live = await fetchLiveDiscoveryCandidates(chain);
      const filteredByProvider = parsed.data.provider === "manual"
        ? live.candidates
        : live.candidates.filter((candidate) => candidate.source === parsed.data.provider);

      return filteredByProvider;
    },
  });

  return NextResponse.json({
    candidates,
    origin: {
      source: candidates.some((candidate) => isOfflineSnapshot(candidate))
        ? "offline_snapshot"
        : "live_provider",
      fetchedAt: new Date().toISOString(),
    },
  });
}
