import type { AgentFinding, AgentResult, AgentSource, RiskLevel } from "@/server/types";
import { buildAgentResult, clampScore } from "@/server/agents/shared";

type NewsAgentInput = {
  tokenName?: string;
  symbol?: string;
  contractAddress?: string;
  projectName?: string;
  websiteUrl?: string;
  chain?: string;
  discovery?: import("@/server/types").DiscoveryAgentContext;
};

type NewsSourceTier = 1 | 2 | 3 | 4;

type NewsSourceKind = "major_news" | "official_project" | "exchange_announcement" | "security_incident" | "aggregator";

type NewsFeed = {
  label: string;
  url: string;
  reliability: number;
  tier: NewsSourceTier;
  kind: NewsSourceKind;
  rssUrl?: string;
};

type NewsItem = {
  title: string;
  link?: string;
  description?: string;
  publishedAt?: Date;
  source: string;
  sourceTier: NewsSourceTier;
  sourceKind: NewsSourceKind;
  reliability: number;
};

type EventType = "positive_catalyst" | "negative_catalyst" | "scam_or_rug" | "regulatory";

type ClassifiedEvent = {
  type: EventType;
  label: string;
  severity: RiskLevel;
  source: string;
  title: string;
  url?: string;
  publishedAt?: string;
  reliability: number;
  identityConfidence: number;
  recencyWeight: number;
  confirmationStatus: "official_confirmed" | "exchange_confirmed" | "security_confirmed" | "unverified_rumor" | "social_only_claim" | "reported";
};

type IdentityTerm = {
  value: string;
  label: string;
  strength: "weak" | "medium" | "high";
};

export type NewsAgentProviders = {
  feeds?: NewsFeed[];
  fetchFeed?: (feed: NewsFeed) => Promise<NewsItem[]>;
  now?: Date;
};

const sourceTierReliability: Record<NewsSourceTier, number> = {
  1: 0.86,
  2: 0.78,
  3: 0.58,
  4: 0.32,
};

const newsSourceRegistry: NewsFeed[] = [
  {
    label: "CoinDesk",
    url: "https://www.coindesk.com",
    rssUrl: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    reliability: sourceTierReliability[1],
    tier: 1,
    kind: "major_news",
  },
  {
    label: "Cointelegraph",
    url: "https://cointelegraph.com",
    rssUrl: "https://cointelegraph.com/rss",
    reliability: 0.78,
    tier: 1,
    kind: "major_news",
  },
  {
    label: "The Block",
    url: "https://www.theblock.co",
    rssUrl: "https://www.theblock.co/rss.xml",
    reliability: 0.82,
    tier: 1,
    kind: "major_news",
  },
  {
    label: "Decrypt",
    url: "https://decrypt.co",
    rssUrl: "https://decrypt.co/feed",
    reliability: 0.74,
    tier: 1,
    kind: "major_news",
  },
  {
    label: "Binance Announcements",
    url: "https://www.binance.com/en/support/announcement",
    reliability: sourceTierReliability[2],
    tier: 2,
    kind: "exchange_announcement",
  },
  {
    label: "Coinbase Assets",
    url: "https://www.coinbase.com/blog/landing/product",
    reliability: sourceTierReliability[2],
    tier: 2,
    kind: "exchange_announcement",
  },
  {
    label: "Rekt News",
    url: "https://rekt.news",
    rssUrl: "https://rekt.news/rss/",
    reliability: 0.72,
    tier: 2,
    kind: "security_incident",
  },
  {
    label: "Security Alliance",
    url: "https://securityalliance.org",
    reliability: sourceTierReliability[2],
    tier: 2,
    kind: "security_incident",
  },
];

const positiveKeywords = [
  "listing",
  "listed",
  "major exchange",
  "coinbase adds",
  "binance will list",
  "partnership",
  "partners with",
  "integrates",
  "integration",
  "funding",
  "raises",
  "mainnet",
  "audit completed",
  "support for",
];

const negativeKeywords = [
  "hack",
  "exploit",
  "drain",
  "drained",
  "stolen",
  "lawsuit",
  "investigation",
  "delisting",
  "delist",
  "bankruptcy",
  "halt",
  "security warning",
];

const scamKeywords = ["rug", "rug pull", "scam", "honeypot", "phishing", "fraud", "impersonation", "drainer"];
const regulatoryKeywords = ["sec", "cftc", "sanction", "sanctions", "compliance action", "court case", "enforcement", "lawsuit"];

const regionalNewsSupportPlan = {
  defaultLanguage: "en",
  supportedRegions: ["global_en", "regional_manual"],
  machineTranslationConfidence: 0.62,
  lowConfidenceTranslationRequiresManualReview: true,
  detail: "English major sources are automated. Regional and translated sources must carry translation confidence and manual-review bias when confidence is low.",
};

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9.:/-]+/g, " ").replace(/\s+/g, " ").trim();
}

function getDomain(url?: string) {
  if (!url) return undefined;

  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function decodeXml(value: string) {
  return value
    .replaceAll("<![CDATA[", "")
    .replaceAll("]]>", "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTag(itemXml: string, tag: string) {
  const match = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));

  return match ? stripHtml(decodeXml(match[1])) : undefined;
}

function parseFeedItems(xml: string, feed: NewsFeed): NewsItem[] {
  const itemBlocks = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi), (match) => match[0]);
  const entryBlocks = itemBlocks.length > 0 ? itemBlocks : Array.from(xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi), (match) => match[0]);

  return entryBlocks.flatMap((itemXml) => {
    const title = extractTag(itemXml, "title");
    const description = extractTag(itemXml, "description") ?? extractTag(itemXml, "summary") ?? extractTag(itemXml, "content");
    const link = extractTag(itemXml, "link") ?? itemXml.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    const pubDate = extractTag(itemXml, "pubDate") ?? extractTag(itemXml, "published") ?? extractTag(itemXml, "updated");
    const publishedAt = pubDate ? new Date(pubDate) : undefined;

    if (!title) {
      return [];
    }

    return [
      {
        title,
        link,
        description,
        publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : undefined,
        source: feed.label,
        sourceTier: feed.tier,
        sourceKind: feed.kind,
        reliability: feed.reliability,
      },
    ];
  });
}

async function fetchFeed(feed: NewsFeed): Promise<NewsItem[]> {
  if (!feed.rssUrl) {
    throw new Error(`${feed.label} has no RSS endpoint configured for automated MVP checks`);
  }

  const response = await fetch(feed.rssUrl, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    next: { revalidate: 60 * 10 },
  });

  if (!response.ok) {
    throw new Error(`${feed.label} RSS failed with ${response.status}`);
  }

  return parseFeedItems(await response.text(), feed);
}

function getIdentityTerms(input: NewsAgentInput): IdentityTerm[] {
  const websiteDomain = getDomain(input.websiteUrl);
  const terms: IdentityTerm[] = [];

  if (input.contractAddress?.trim()) terms.push({ value: input.contractAddress.trim().toLowerCase(), label: "contract address", strength: "high" });
  if (websiteDomain) terms.push({ value: websiteDomain, label: "website domain", strength: "high" });
  if (input.tokenName?.trim()) terms.push({ value: input.tokenName.trim().toLowerCase(), label: "token name", strength: "medium" });
  if (input.projectName?.trim()) terms.push({ value: input.projectName.trim().toLowerCase(), label: "project name", strength: "medium" });
  if (input.symbol?.trim()) terms.push({ value: input.symbol.trim().toLowerCase(), label: "symbol", strength: "weak" });
  if (input.chain?.trim()) terms.push({ value: input.chain.trim().toLowerCase(), label: "chain", strength: "weak" });

  return terms;
}

function itemText(item: NewsItem) {
  return normalizeText(`${item.title} ${item.description ?? ""} ${item.link ?? ""}`);
}

function containsAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function getIdentityMatch(item: NewsItem, terms: IdentityTerm[]) {
  const text = itemText(item);
  const matchedTerms = terms.filter((term) => text.includes(term.value));
  const hasHigh = matchedTerms.some((term) => term.strength === "high");
  const hasMedium = matchedTerms.some((term) => term.strength === "medium");
  const hasWeak = matchedTerms.some((term) => term.strength === "weak");
  const confidence = hasHigh ? 0.92 : hasMedium && hasWeak ? 0.68 : hasMedium ? 0.52 : hasWeak ? 0.28 : 0;

  return {
    matchedTerms,
    confidence,
  };
}

function extractNewsEntity(item: NewsItem, terms: IdentityTerm[]) {
  const title = normalizeText(item.title);
  const body = normalizeText(item.description ?? "");
  const link = normalizeText(item.link ?? "");
  const titleMatches = terms.filter((term) => title.includes(term.value));
  const bodyMatches = terms.filter((term) => body.includes(term.value) || link.includes(term.value));
  const highConfidenceMatches = [...titleMatches, ...bodyMatches].filter((term) => term.strength === "high");
  const titleBodyConflict = titleMatches.length > 0 && bodyMatches.length > 0 && !titleMatches.some((titleTerm) => bodyMatches.some((bodyTerm) => bodyTerm.value === titleTerm.value));

  return {
    titleEntityTerms: titleMatches.map((term) => term.label),
    bodyEntityTerms: bodyMatches.map((term) => term.label),
    contractOrWebsiteMatched: highConfidenceMatches.length > 0,
    symbolCollisionPossible: terms.some((term) => term.label === "symbol") && highConfidenceMatches.length === 0,
    titleBodyConflict,
  };
}

function getSourceCredibility(item: NewsItem) {
  const text = itemText(item);
  const sponsored = text.includes("sponsored") || text.includes("press release") || text.includes("partner content");

  return {
    source: item.source,
    tier: item.sourceTier,
    historicalReliability: item.reliability,
    sourceType: item.sourceKind === "official_project" || item.sourceKind === "exchange_announcement" ? "official" : "third_party",
    sponsoredOrPressRelease: sponsored,
    aggregatorDuplicateRisk: item.sourceKind === "aggregator",
  };
}

function getConfirmationStatus(item: NewsItem): ClassifiedEvent["confirmationStatus"] {
  const text = itemText(item);

  if (item.sourceKind === "exchange_announcement") return "exchange_confirmed";
  if (item.sourceKind === "security_incident") return "security_confirmed";
  if (item.sourceKind === "official_project") return "official_confirmed";
  if (text.includes("rumor") || text.includes("unconfirmed") || text.includes("reportedly")) return "unverified_rumor";
  if (text.includes("tweet") || text.includes("social post") || text.includes("influencer")) return "social_only_claim";

  return "reported";
}

function getEventTimeline(events: ClassifiedEvent[]) {
  const timestamps = events
    .map((event) => event.publishedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));
  const sourceCount = events.length;
  const independentSourceCount = new Set(events.map((event) => event.source)).size;
  const newest = timestamps.length > 0 ? Math.max(...timestamps) : undefined;

  return {
    firstSeen: timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : undefined,
    lastSeen: newest ? new Date(newest).toISOString() : undefined,
    sourceCount,
    independentSourceCount,
    eventStillActive: newest ? Date.now() - newest <= 30 * 86_400_000 : false,
  };
}

function titleKey(title: string) {
  return normalizeText(title).replace(/\b(the|a|an|to|for|of|and|in|on)\b/g, "").replace(/\s+/g, " ").trim();
}

function dedupeItems(items: NewsItem[]) {
  const seen = new Set<string>();

  return items.filter((item) => {
    const urlKey = item.link ? `url:${item.link.toLowerCase().split("?")[0]}` : undefined;
    const itemTitleKey = `title:${titleKey(item.title)}`;
    const key = urlKey ?? itemTitleKey;

    if (seen.has(key) || seen.has(itemTitleKey)) {
      return false;
    }

    seen.add(key);
    seen.add(itemTitleKey);
    return true;
  });
}

function getRecencyWeight(item: NewsItem, now: Date) {
  if (!item.publishedAt) return 0.65;

  const ageDays = Math.max(0, (now.getTime() - item.publishedAt.getTime()) / 86_400_000);

  if (ageDays <= 1) return 1;
  if (ageDays <= 7) return 0.78;
  if (ageDays <= 30) return 0.42;

  return 0;
}

function filterRelevantItems(items: NewsItem[], terms: IdentityTerm[], now: Date) {
  return dedupeItems(items)
    .map((item) => {
      const identity = getIdentityMatch(item, terms);
      const recencyWeight = getRecencyWeight(item, now);

      return { item, identity, recencyWeight };
    })
    .filter(({ identity, recencyWeight }) => identity.confidence > 0 && recencyWeight > 0)
    .sort((a, b) => {
      const confidenceGap = b.identity.confidence - a.identity.confidence;

      return confidenceGap !== 0 ? confidenceGap : (b.item.publishedAt?.getTime() ?? 0) - (a.item.publishedAt?.getTime() ?? 0);
    })
    .slice(0, 16);
}

function severityFromEvent(type: EventType, item: NewsItem) {
  const text = itemText(item);
  const officialOrSecurity = item.sourceKind === "exchange_announcement" || item.sourceKind === "security_incident";

  if (type === "scam_or_rug") return text.includes("phishing") || text.includes("drainer") || text.includes("rug") ? "critical" : "high";
  if (type === "negative_catalyst") return text.includes("hack") || text.includes("exploit") || text.includes("delisting") || officialOrSecurity ? "high" : "medium";
  if (type === "regulatory") return officialOrSecurity || text.includes("enforcement") || text.includes("sanction") ? "high" : "medium";

  return "low";
}

function classifyEvents(relevantItems: ReturnType<typeof filterRelevantItems>): ClassifiedEvent[] {
  return relevantItems.flatMap(({ item, identity, recencyWeight }) => {
    const text = itemText(item);
    const events: Array<{ type: EventType; label: string }> = [];

    if (containsAny(text, positiveKeywords)) events.push({ type: "positive_catalyst", label: "Positive catalyst" });
    if (containsAny(text, negativeKeywords)) events.push({ type: "negative_catalyst", label: "Negative catalyst" });
    if (containsAny(text, scamKeywords)) events.push({ type: "scam_or_rug", label: "Scam/rug mention" });
    if (containsAny(text, regulatoryKeywords)) events.push({ type: "regulatory", label: "Regulatory mention" });

    return events.map((event) => ({
      ...event,
      severity: severityFromEvent(event.type, item),
      source: item.source,
      title: item.title,
      url: item.link,
      publishedAt: item.publishedAt?.toISOString(),
      reliability: item.reliability,
      identityConfidence: identity.confidence,
      recencyWeight,
      confirmationStatus: getConfirmationStatus(item),
    }));
  });
}

function scoreForSeverity(severity: RiskLevel) {
  return {
    low: 12,
    medium: 42,
    high: 72,
    critical: 94,
  }[severity];
}

function average(values: number[]) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function severityForScore(score: number): RiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";

  return "low";
}

function getEventScore(events: ClassifiedEvent[], types: EventType[]) {
  const matched = events.filter((event) => types.includes(event.type));

  if (matched.length === 0) return 0;

  return clampScore(
    matched.reduce((total, event) => total + scoreForSeverity(event.severity) * event.recencyWeight, 0) / matched.length,
  );
}

function getCoverageScore(connectedSourceCount: number, relevantItemCount: number) {
  if (connectedSourceCount === 0) return 85;
  if (relevantItemCount === 0) return 45;
  if (connectedSourceCount >= 3) return 8;

  return 22;
}

function getIdentityRisk(identityConfidence: number) {
  if (identityConfidence >= 0.75) return 8;
  if (identityConfidence >= 0.45) return 28;
  if (identityConfidence > 0) return 64;

  return 70;
}

function getSourceReliabilityRisk(reliability: number) {
  if (reliability >= 0.8) return 8;
  if (reliability >= 0.6) return 24;
  if (reliability > 0) return 55;

  return 72;
}

function getRecencyRisk(recencyWeight: number) {
  if (recencyWeight >= 0.78) return 10;
  if (recencyWeight >= 0.42) return 34;
  if (recencyWeight > 0) return 50;

  return 58;
}

function getNewsScore(input: {
  events: ClassifiedEvent[];
  connectedSourceCount: number;
  relevantItemCount: number;
  averageReliability: number;
  averageIdentityConfidence: number;
  averageRecencyWeight: number;
  independentSourceCount: number;
}) {
  const negativeSecurityScore = getEventScore(input.events, ["negative_catalyst"]);
  const scamRegulatoryScore = getEventScore(input.events, ["scam_or_rug", "regulatory"]);
  const sourceReliabilityRisk = getSourceReliabilityRisk(input.averageReliability);
  const identityRisk = getIdentityRisk(input.averageIdentityConfidence);
  const recencyRisk = getRecencyRisk(input.averageRecencyWeight);
  const sourceCoverageRisk = getCoverageScore(input.connectedSourceCount, input.relevantItemCount);
  const positiveCatalystCount = input.events.filter((event) => event.type === "positive_catalyst").length;
  const positiveOffset = Math.min(12, positiveCatalystCount * 4);
  const independentSourceRisk = input.independentSourceCount >= 3 ? 8 : input.independentSourceCount >= 2 ? 22 : input.independentSourceCount === 1 ? 42 : 62;
  const baseScore =
    negativeSecurityScore * 0.3 +
    scamRegulatoryScore * 0.2 +
    sourceReliabilityRisk * 0.15 +
    identityRisk * 0.15 +
    recencyRisk * 0.1 +
    independentSourceRisk * 0.05 +
    sourceCoverageRisk * 0.05;

  return clampScore(baseScore - positiveOffset);
}

function buildNewsFindings(input: {
  relevantItems: ReturnType<typeof filterRelevantItems>;
  events: ClassifiedEvent[];
  connectedSourceCount: number;
  averageReliability: number;
  averageIdentityConfidence: number;
  averageRecencyWeight: number;
  score: number;
}): AgentFinding[] {
  const positiveEvents = input.events.filter((event) => event.type === "positive_catalyst");
  const negativeEvents = input.events.filter((event) => event.type === "negative_catalyst");
  const scamEvents = input.events.filter((event) => event.type === "scam_or_rug");
  const regulatoryEvents = input.events.filter((event) => event.type === "regulatory");
  const strongestEvent = [...input.events].sort((left, right) => scoreForSeverity(right.severity) - scoreForSeverity(left.severity))[0];
  const eventTimeline = getEventTimeline(input.events);
  const entityExtractions = input.relevantItems.map(({ item, identity }) => extractNewsEntity(item, identity.matchedTerms));
  const titleBodyConflicts = entityExtractions.filter((entity) => entity.titleBodyConflict).length;
  const symbolCollisionItems = entityExtractions.filter((entity) => entity.symbolCollisionPossible).length;
  const credibility = input.relevantItems.map(({ item }) => getSourceCredibility(item));
  const sponsoredCount = credibility.filter((item) => item.sponsoredOrPressRelease).length;
  const aggregatorDuplicateCount = credibility.filter((item) => item.aggregatorDuplicateRisk).length;
  const unconfirmedCount = input.events.filter((event) => event.confirmationStatus === "unverified_rumor" || event.confirmationStatus === "social_only_claim").length;

  if (input.connectedSourceCount === 0) {
    return [
      {
        label: "News source coverage",
        severity: "medium",
        detail: "No configured news source was reachable. News Agent cannot produce a safe signal from unavailable data.",
        scoreImpact: 58,
        interpretation: "Decision Agent should treat this as missing coverage and require manual review.",
      },
    ];
  }

  return [
    {
      label: "Multilingual and regional coverage",
      severity: regionalNewsSupportPlan.machineTranslationConfidence < 0.7 ? "medium" : "low",
      detail: `Automated coverage is ${regionalNewsSupportPlan.defaultLanguage.toUpperCase()} major sources first; regional/translated sources require confidence ${Math.round(regionalNewsSupportPlan.machineTranslationConfidence * 100)}% and manual-review bias when low.`,
      scoreImpact: regionalNewsSupportPlan.machineTranslationConfidence < 0.7 ? 36 : 10,
      raw: JSON.stringify(regionalNewsSupportPlan),
    },
    {
      label: "Event timeline",
      severity: eventTimeline.eventStillActive ? "medium" : input.events.length > 0 ? "low" : "medium",
      detail: `${eventTimeline.sourceCount} event source${eventTimeline.sourceCount === 1 ? "" : "s"}, ${eventTimeline.independentSourceCount} independent source${eventTimeline.independentSourceCount === 1 ? "" : "s"}; first seen ${eventTimeline.firstSeen ?? "unknown"}, last seen ${eventTimeline.lastSeen ?? "unknown"}.`,
      scoreImpact: eventTimeline.eventStillActive ? 34 : 12,
      raw: JSON.stringify(eventTimeline),
    },
    {
      label: "News entity extraction",
      severity: titleBodyConflicts > 0 || symbolCollisionItems > 0 ? "high" : input.relevantItems.length > 0 ? "low" : "medium",
      detail: `${input.relevantItems.length} article entity extraction${input.relevantItems.length === 1 ? "" : "s"} completed; ${titleBodyConflicts} title/body conflict${titleBodyConflicts === 1 ? "" : "s"}, ${symbolCollisionItems} symbol-collision warning${symbolCollisionItems === 1 ? "" : "s"}.`,
      scoreImpact: titleBodyConflicts > 0 ? 72 : symbolCollisionItems > 0 ? 58 : 12,
      raw: JSON.stringify(entityExtractions),
    },
    {
      label: "Source credibility registry",
      severity: sponsoredCount > 0 || aggregatorDuplicateCount > 0 ? "medium" : "low",
      detail: `${credibility.length} matched source credibility profile${credibility.length === 1 ? "" : "s"} evaluated; ${sponsoredCount} sponsored/press-release flag${sponsoredCount === 1 ? "" : "s"}, ${aggregatorDuplicateCount} aggregator duplicate risk flag${aggregatorDuplicateCount === 1 ? "" : "s"}.`,
      scoreImpact: sponsoredCount > 0 || aggregatorDuplicateCount > 0 ? 34 : 10,
      raw: JSON.stringify(credibility),
    },
    {
      label: "Rumor versus confirmed",
      severity: unconfirmedCount > 0 ? "medium" : input.events.length > 0 ? "low" : "medium",
      detail: `${input.events.length} classified event${input.events.length === 1 ? "" : "s"} checked for confirmation status; ${unconfirmedCount} unverified rumor/social-only claim${unconfirmedCount === 1 ? "" : "s"}.`,
      scoreImpact: unconfirmedCount > 0 ? 42 : 12,
      raw: JSON.stringify(input.events.map((event) => ({ title: event.title, source: event.source, confirmationStatus: event.confirmationStatus }))),
    },
    {
      label: "Matched articles",
      severity: input.relevantItems.length > 0 ? "low" : "medium",
      detail:
        input.relevantItems.length > 0
          ? `${input.relevantItems.length} deduped article${input.relevantItems.length === 1 ? "" : "s"} matched token identity within the 30-day recency window.`
          : "No matching article was found in connected sources. This is not proof that the token is safe.",
      scoreImpact: input.relevantItems.length > 0 ? 8 : 45,
    },
    {
      label: "Negative catalysts",
      severity: severityForScore(getEventScore(input.events, ["negative_catalyst"])),
      detail: `${negativeEvents.length} matched event${negativeEvents.length === 1 ? "" : "s"} mention hack, exploit, lawsuit, delisting, halt or security warning language.`,
      scoreImpact: getEventScore(input.events, ["negative_catalyst"]),
    },
    {
      label: "Scam or rug events",
      severity: severityForScore(getEventScore(input.events, ["scam_or_rug"])),
      detail: `${scamEvents.length} matched event${scamEvents.length === 1 ? "" : "s"} mention scam, rug, phishing, fraud, impersonation, honeypot or drainer language.`,
      scoreImpact: getEventScore(input.events, ["scam_or_rug"]),
    },
    {
      label: "Regulatory events",
      severity: severityForScore(getEventScore(input.events, ["regulatory"])),
      detail: `${regulatoryEvents.length} matched event${regulatoryEvents.length === 1 ? "" : "s"} mention SEC/CFTC, sanctions, enforcement, compliance action or court case language.`,
      scoreImpact: getEventScore(input.events, ["regulatory"]),
    },
    {
      label: "Positive catalysts",
      severity: "low",
      detail: `${positiveEvents.length} matched event${positiveEvents.length === 1 ? "" : "s"} mention listing, exchange support, mainnet, funding, partnership, integration or completed audit language. Positive catalysts reduce but never erase risk.`,
      scoreImpact: Math.max(0, 20 - positiveEvents.length * 4),
    },
    {
      label: "Source reliability",
      severity: input.averageReliability >= 0.8 ? "low" : input.averageReliability >= 0.6 ? "medium" : "high",
      detail: `Average matched-source reliability is ${Math.round(input.averageReliability * 100)}% using tiered source scoring.`,
      scoreImpact: getSourceReliabilityRisk(input.averageReliability),
    },
    {
      label: "Identity match confidence",
      severity: input.averageIdentityConfidence >= 0.75 ? "low" : input.averageIdentityConfidence >= 0.45 ? "medium" : "high",
      detail: `Average identity match confidence is ${Math.round(input.averageIdentityConfidence * 100)}%. Symbol-only matches remain low confidence.`,
      scoreImpact: getIdentityRisk(input.averageIdentityConfidence),
    },
    {
      label: "Event severity",
      severity: strongestEvent?.severity ?? "low",
      detail: strongestEvent
        ? `Strongest event is ${strongestEvent.label.toLowerCase()} from ${strongestEvent.source}: ${strongestEvent.title}.`
        : "No classified news event was found in matched articles.",
      scoreImpact: strongestEvent ? scoreForSeverity(strongestEvent.severity) : 0,
    },
    {
      label: "News risk formula",
      severity: severityForScore(input.score),
      detail: "Score uses negative/security events, scam/regulatory mentions, source reliability, identity confidence, recency, independent source count and positive catalyst offset.",
      scoreImpact: input.score,
    },
  ];
}

function getRecommendedAction(score: number, connectedSourceCount: number, identityConfidence: number) {
  if (connectedSourceCount === 0) return "manual_review";
  if (score >= 75) return "manual_review";
  if (score >= 50) return "manual_review";
  if (identityConfidence < 0.35) return "manual_review";
  if (score >= 25) return "watch";

  return "hold";
}

export async function runNewsAgent(input: NewsAgentInput, providers: NewsAgentProviders = {}): Promise<AgentResult> {
  const subject = input.symbol || input.tokenName || input.projectName || input.contractAddress || "token";
  const identityTerms = getIdentityTerms(input);
  const now = providers.now ?? new Date();
  const feeds = providers.feeds ?? newsSourceRegistry;
  const fetchNewsFeed = providers.fetchFeed ?? fetchFeed;

  if (identityTerms.length === 0) {
    return buildAgentResult({
      agent: "news",
      score: 58,
      verdict: "Missing news search input",
      summary: "News Agent needs a token symbol, token name, contract address, website or chain to search safely.",
      findings: [
        {
          label: "News input",
          severity: "medium",
          detail: "Provide tokenName, symbol, contractAddress, projectName, websiteUrl or chain.",
        },
      ],
      sources: [],
      confidence: 0.25,
      recommendedAction: "manual_review",
    });
  }

  const feedResults = await Promise.allSettled(feeds.map(fetchNewsFeed));
  const items = feedResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const relevantItems = filterRelevantItems(items, identityTerms, now);
  const events = classifyEvents(relevantItems);
  const connectedSourceCount = feedResults.filter((result) => result.status === "fulfilled").length;
  const matchedReliabilities = relevantItems.map(({ item }) => item.reliability);
  const averageReliability = average(matchedReliabilities) || average(feedResults.map((result, index) => (result.status === "fulfilled" ? feeds[index].reliability : 0)).filter(Boolean));
  const averageIdentityConfidence = average(relevantItems.map(({ identity }) => identity.confidence)) || (identityTerms.every((term) => term.strength === "weak") ? 0.22 : 0.38);
  const averageRecencyWeight = average(relevantItems.map(({ recencyWeight }) => recencyWeight));
  const independentSourceCount = new Set(relevantItems.map(({ item }) => item.source)).size;
  const score = connectedSourceCount === 0
    ? 58
    : getNewsScore({
        events,
        connectedSourceCount,
        relevantItemCount: relevantItems.length,
        averageReliability,
        averageIdentityConfidence,
        averageRecencyWeight,
        independentSourceCount,
      });
  const findings = buildNewsFindings({
    relevantItems,
    events,
    connectedSourceCount,
    averageReliability,
    averageIdentityConfidence,
    averageRecencyWeight,
    score,
  });
  const checkedAt = now.toISOString();
  const sources: AgentSource[] = feedResults.map((result, index) => ({
    label: feeds[index].label,
    url: feeds[index].rssUrl ?? feeds[index].url,
    status: result.status === "fulfilled" ? "connected" : "unavailable",
    detail:
      result.status === "fulfilled"
        ? `${result.value.length} item${result.value.length === 1 ? "" : "s"} fetched from ${feeds[index].kind} tier ${feeds[index].tier}.`
        : `${feeds[index].kind} source unavailable or not configured for automated fetch.`,
    checkedAt,
    reliability: result.status === "fulfilled" ? feeds[index].reliability : 0.12,
  }));
  const matchedArticleSources: AgentSource[] = relevantItems.slice(0, 8).map(({ item, identity, recencyWeight }) => ({
    label: `${item.source}: ${item.title.slice(0, 72)}`,
    url: item.link,
    status: "connected",
    detail: `Matched article with ${Math.round(identity.confidence * 100)}% identity confidence and ${Math.round(recencyWeight * 100)}% recency weight.`,
    checkedAt,
    reliability: item.reliability,
  }));
  const recommendedAction = getRecommendedAction(score, connectedSourceCount, averageIdentityConfidence);

  return buildAgentResult({
    agent: "news",
    score,
    verdict:
      connectedSourceCount === 0
        ? "News sources unavailable"
        : score >= 75
          ? "Critical news risk detected"
          : score >= 50
            ? "Negative news risk detected"
            : score >= 25
              ? "News review needed"
              : "No major news risk",
    summary:
      connectedSourceCount === 0
        ? `${subject} could not be checked because configured news sources were unavailable.`
        : relevantItems.length > 0
          ? `${subject} matched ${relevantItems.length} deduped recent article${relevantItems.length === 1 ? "" : "s"} and ${events.length} classified event${events.length === 1 ? "" : "s"}.`
          : `${subject} had no recent matching coverage across connected sources; this is treated as partial information.`,
    findings,
    sources: [...sources, ...matchedArticleSources],
    confidence: connectedSourceCount === 0 ? 0.2 : Math.min(0.74, 0.34 + connectedSourceCount * 0.08 + averageIdentityConfidence * 0.22),
    recommendedAction,
    blockingReasons: connectedSourceCount === 0 ? ["No connected news source contributed to this result."] : [],
    missingData:
      connectedSourceCount === 0
        ? [
            {
              field: "news sources",
              reason: "All configured news sources were unavailable.",
              impact: "high",
              requiredFor: "news risk confidence",
            },
          ]
        : relevantItems.length === 0
          ? [
              {
                field: "matched coverage",
                reason: "Connected news sources returned no article matching the resolved token identity.",
                impact: "medium",
                requiredFor: "news event classification",
              },
            ]
          : [],
    rawSignals: {
      sourceRegistry: feeds.map((feed) => ({
        label: feed.label,
        tier: feed.tier,
        kind: feed.kind,
        reliability: feed.reliability,
        automatedFetch: Boolean(feed.rssUrl),
      })),
      identityTerms,
      matchedArticles: relevantItems.map(({ item, identity, recencyWeight }) => ({
        title: item.title,
        url: item.link,
        source: item.source,
        sourceTier: item.sourceTier,
        sourceReliability: item.reliability,
        publishedAt: item.publishedAt?.toISOString(),
        identityMatchConfidence: identity.confidence,
        matchedTerms: identity.matchedTerms.map((term) => term.label),
        recencyWeight,
      })),
      entityExtraction: relevantItems.map(({ item, identity }) => ({
        title: item.title,
        source: item.source,
        ...extractNewsEntity(item, identity.matchedTerms),
      })),
      sourceCredibility: relevantItems.map(({ item }) => getSourceCredibility(item)),
      confirmationStatus: events.map((event) => ({
        title: event.title,
        source: event.source,
        type: event.type,
        confirmationStatus: event.confirmationStatus,
      })),
      regionalSupport: regionalNewsSupportPlan,
      eventTimeline: getEventTimeline(events),
      events,
      sourceReliability: averageReliability,
      identityMatchConfidence: averageIdentityConfidence,
      positiveCatalysts: events.filter((event) => event.type === "positive_catalyst"),
      negativeCatalysts: events.filter((event) => event.type !== "positive_catalyst"),
      recencyWindows: {
        last24h: relevantItems.filter(({ item }) => item.publishedAt && now.getTime() - item.publishedAt.getTime() <= 86_400_000).length,
        last7d: relevantItems.filter(({ item }) => item.publishedAt && now.getTime() - item.publishedAt.getTime() <= 7 * 86_400_000).length,
        last30d: relevantItems.filter(({ item }) => item.publishedAt && now.getTime() - item.publishedAt.getTime() <= 30 * 86_400_000).length,
      },
    },
  });
}
