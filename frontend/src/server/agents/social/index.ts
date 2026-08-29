import type { AgentFinding, AgentResult, AgentSource, RiskLevel } from "@/server/types";
import { buildAgentResult, clampScore } from "@/server/agents/shared";
import { evaluateUrlSafety } from "@/server/security/urlSafety";

type SocialAgentInput = {
  query?: string;
  symbol?: string;
  tokenName?: string;
  contractAddress?: string;
  websiteUrl?: string;
  twitterUrl?: string;
  telegramUrl?: string;
  discordUrl?: string;
  dexScreenerPairUrl?: string;
  coingeckoId?: string;
  discovery?: import("@/server/types").DiscoveryAgentContext;
};

type SocialMetadata = {
  url: string;
  title?: string;
  description?: string;
  reachable: boolean;
  links: string[];
  text: string;
};

type SocialAccount = {
  handle: string;
  displayName?: string;
  bio?: string;
  createdAt?: string;
  verified?: boolean;
  followers?: number;
  following?: number;
  postCount?: number;
  profileUrl?: string;
  websiteUrl?: string;
};

type SocialPost = {
  id?: string;
  authorHandle?: string;
  text: string;
  url?: string;
  createdAt?: string;
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  viewCount?: number;
  links?: string[];
  replies?: SocialReply[];
};

type SocialReply = {
  authorHandle?: string;
  text: string;
  createdAt?: string;
  authorCreatedAt?: string;
  likeCount?: number;
};

type SocialProviderData = {
  account?: SocialAccount;
  officialPosts?: SocialPost[];
  searchPosts?: SocialPost[];
  replies?: SocialReply[];
  providerLabel?: string;
};

type SocialAgentProviders = {
  fetchMetadata?: (url: string) => Promise<SocialMetadata>;
  fetchSocialData?: (input: SocialAgentInput, handle?: string) => Promise<SocialProviderData | undefined>;
  now?: Date;
};

type LinkSafetySummary = {
  linksChecked: number;
  suspiciousLinks: string[];
  mismatchedLinks: string[];
  officialDomains: string[];
  riskScore: number;
};

type BotShillSummary = {
  repeatedTextGroups: number;
  lowQualityReplyCount: number;
  hypePostCount: number;
  newReplyAccountCount: number;
  riskScore: number;
};

const phishingKeywords = [
  "airdrop",
  "claim",
  "free",
  "giveaway",
  "presale",
  "guaranteed",
  "100x",
  "1000x",
  "connect wallet",
  "seed phrase",
  "private key",
  "wallet connect",
  "verify wallet",
];

const scamKeywords = ["scam", "rug", "rugged", "phishing", "fake", "impersonation", "drainer", "honeypot", "fraud"];
const qualityKeywords = ["docs", "documentation", "audit", "github", "whitepaper", "roadmap", "team", "technical", "mainnet", "security"];
const supportKeywords = ["support", "fixed", "resolved", "answered", "update", "release", "changelog"];
const complaintKeywords = ["scam", "withdrawal", "cannot sell", "can't sell", "fake airdrop", "contract mismatch", "stolen", "drained"];

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9.:/@#$-]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUrl(value?: string) {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const url = new URL(value.trim());

    return url.toString();
  } catch {
    return undefined;
  }
}

function getDomain(url?: string) {
  const normalized = normalizeUrl(url);

  if (!normalized) return undefined;

  return new URL(normalized).hostname.replace(/^www\./, "").toLowerCase();
}

function extractMeta(html: string, property: string) {
  const propertyMatch = html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"));
  const nameMatch = html.match(new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"));

  return propertyMatch?.[1] ?? nameMatch?.[1];
}

function extractTitle(html: string) {
  return extractMeta(html, "og:title") ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
}

function extractDescription(html: string) {
  return extractMeta(html, "og:description") ?? extractMeta(html, "description");
}

function stripHtml(html: string) {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractLinks(html: string) {
  return Array.from(html.matchAll(/href=["']([^"']+)["']/gi), (match) => match[1])
    .map((value) => normalizeUrl(value))
    .filter((value): value is string => Boolean(value));
}

async function fetchMetadata(url: string): Promise<SocialMetadata> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "GoldenRaccoonBot/1.0",
    },
    next: { revalidate: 60 * 15 },
  });

  if (!response.ok) {
    throw new Error(`Metadata request failed with ${response.status}`);
  }

  const html = await response.text();

  return {
    url,
    title: extractTitle(html),
    description: extractDescription(html),
    reachable: true,
    links: extractLinks(html),
    text: stripHtml(html),
  };
}

function getTwitterHandle(twitterUrl?: string, query?: string) {
  const candidate = twitterUrl ?? query;

  if (!candidate) {
    return undefined;
  }

  const match = candidate.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i) ?? candidate.match(/^@?([a-zA-Z0-9_]{2,30})$/);

  return match?.[1]?.replace("@", "");
}

function getProviderHealthSources(): AgentSource[] {
  return [
    {
      label: "X API",
      status: process.env.X_BEARER_TOKEN ? "connected" : "unavailable",
      detail: process.env.X_BEARER_TOKEN ? "X API bearer token is configured for account and post fetches." : "X API bearer token is not configured.",
      reliability: process.env.X_BEARER_TOKEN ? 0.8 : 0.1,
    },
    {
      label: "Apify social fallback",
      status: process.env.APIFY_TOKEN ? "connected" : "unavailable",
      detail: process.env.APIFY_TOKEN ? "Apify token is configured as a social scraping fallback." : "Apify token is not configured.",
      reliability: process.env.APIFY_TOKEN ? 0.66 : 0.1,
    },
    {
      label: "Tavily search fallback",
      status: process.env.TAVILY_API_KEY ? "connected" : "unavailable",
      detail: process.env.TAVILY_API_KEY ? "Tavily key is configured for search-based social discovery." : "Tavily key is not configured.",
      reliability: process.env.TAVILY_API_KEY ? 0.58 : 0.1,
    },
    {
      label: "Generic social provider",
      status: process.env.SOCIAL_DATA_PROVIDER_URL ? "connected" : "unavailable",
      detail: process.env.SOCIAL_DATA_PROVIDER_URL ? "SOCIAL_DATA_PROVIDER_URL is configured." : "No generic social data provider URL is configured.",
      reliability: process.env.SOCIAL_DATA_PROVIDER_URL ? 0.72 : 0.1,
    },
  ];
}

async function fetchFromGenericProvider(input: SocialAgentInput, handle?: string) {
  if (!process.env.SOCIAL_DATA_PROVIDER_URL) {
    return undefined;
  }

  const response = await fetch(process.env.SOCIAL_DATA_PROVIDER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...input, handle }),
    next: { revalidate: 60 * 5 },
  });

  if (!response.ok) {
    throw new Error(`Generic social provider failed with ${response.status}`);
  }

  return (await response.json()) as SocialProviderData;
}

async function fetchFromXApi(input: SocialAgentInput, handle?: string): Promise<SocialProviderData | undefined> {
  if (!process.env.X_BEARER_TOKEN || !handle) {
    return undefined;
  }

  const userUrl = new URL(`https://api.x.com/2/users/by/username/${handle}`);
  userUrl.searchParams.set("user.fields", "created_at,description,public_metrics,verified,url,name,username");

  const userResponse = await fetch(userUrl, {
    headers: {
      Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
    },
    next: { revalidate: 60 * 5 },
  });

  if (!userResponse.ok) {
    throw new Error(`X user request failed with ${userResponse.status}`);
  }

  const userPayload = (await userResponse.json()) as {
    data?: {
      id?: string;
      username?: string;
      name?: string;
      description?: string;
      created_at?: string;
      verified?: boolean;
      url?: string;
      public_metrics?: {
        followers_count?: number;
        following_count?: number;
        tweet_count?: number;
      };
    };
  };
  const user = userPayload.data;

  if (!user?.id || !user.username) {
    return undefined;
  }

  const tweetsUrl = new URL(`https://api.x.com/2/users/${user.id}/tweets`);
  tweetsUrl.searchParams.set("max_results", "10");
  tweetsUrl.searchParams.set("tweet.fields", "created_at,public_metrics,entities");

  const tweetsResponse = await fetch(tweetsUrl, {
    headers: {
      Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
    },
    next: { revalidate: 60 * 5 },
  });
  const tweetsPayload = tweetsResponse.ok
    ? ((await tweetsResponse.json()) as {
        data?: Array<{
          id?: string;
          text?: string;
          created_at?: string;
          public_metrics?: {
            like_count?: number;
            reply_count?: number;
            retweet_count?: number;
          };
          entities?: {
            urls?: Array<{ expanded_url?: string; url?: string }>;
          };
        }>;
      })
    : {};

  return {
    providerLabel: "X API",
    account: {
      handle: user.username,
      displayName: user.name,
      bio: user.description,
      createdAt: user.created_at,
      verified: user.verified,
      followers: user.public_metrics?.followers_count,
      following: user.public_metrics?.following_count,
      postCount: user.public_metrics?.tweet_count,
      profileUrl: `https://x.com/${user.username}`,
      websiteUrl: user.url,
    },
    officialPosts: (tweetsPayload.data ?? []).map((tweet) => ({
      id: tweet.id,
      authorHandle: user.username,
      text: tweet.text ?? "",
      url: tweet.id ? `https://x.com/${user.username}/status/${tweet.id}` : undefined,
      createdAt: tweet.created_at,
      likeCount: tweet.public_metrics?.like_count,
      replyCount: tweet.public_metrics?.reply_count,
      repostCount: tweet.public_metrics?.retweet_count,
      links: tweet.entities?.urls?.flatMap((url) => [url.expanded_url, url.url].filter((value): value is string => Boolean(value))) ?? [],
    })),
  };
}

async function fetchSocialProviderData(input: SocialAgentInput, handle?: string) {
  const generic = await fetchFromGenericProvider(input, handle).catch(() => undefined);

  if (generic) {
    return generic;
  }

  return fetchFromXApi(input, handle).catch(() => undefined);
}

function getCandidateUrls(input: SocialAgentInput) {
  return [
    normalizeUrl(input.websiteUrl),
    normalizeUrl(input.twitterUrl),
    normalizeUrl(input.telegramUrl),
    normalizeUrl(input.discordUrl),
    normalizeUrl(input.dexScreenerPairUrl),
  ].filter((url): url is string => Boolean(url));
}

function getAllText(metadata: SocialMetadata[], data?: SocialProviderData) {
  const postText = [...(data?.officialPosts ?? []), ...(data?.searchPosts ?? [])].map((post) => post.text).join(" ");
  const replyText = [...(data?.replies ?? []), ...(data?.officialPosts ?? []).flatMap((post) => post.replies ?? [])].map((reply) => reply.text).join(" ");
  const accountText = `${data?.account?.displayName ?? ""} ${data?.account?.bio ?? ""} ${data?.account?.websiteUrl ?? ""}`;

  return normalizeText(`${metadata.map((item) => `${item.title ?? ""} ${item.description ?? ""} ${item.text} ${item.url}`).join(" ")} ${accountText} ${postText} ${replyText}`);
}

function countMatches(text: string, keywords: string[]) {
  return keywords.filter((keyword) => text.includes(keyword)).length;
}

function severityForScore(score: number): RiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";

  return "low";
}

function accountAgeDays(account: SocialAccount | undefined, now: Date) {
  if (!account?.createdAt) return undefined;
  const createdAt = new Date(account.createdAt);

  if (Number.isNaN(createdAt.getTime())) return undefined;

  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000));
}

function resolveOfficialIdentity(input: SocialAgentInput, metadata: SocialMetadata[], data: SocialProviderData | undefined, now: Date) {
  const providedHandle = getTwitterHandle(input.twitterUrl, input.query);
  const websiteLinks = metadata.flatMap((item) => item.links);
  const websiteHandle = websiteLinks.map((link) => getTwitterHandle(link)).find(Boolean);
  const providerHandle = data?.account?.handle;
  const handle = providedHandle ?? websiteHandle ?? providerHandle;
  const accountProfile = data?.account?.profileUrl;
  const websiteDomain = getDomain(input.websiteUrl);
  const accountWebsiteDomain = getDomain(data?.account?.websiteUrl);
  const bioText = normalizeText(data?.account?.bio ?? "");
  const officialPosts = data?.officialPosts ?? [];
  const contractMentioned = Boolean(input.contractAddress && officialPosts.some((post) => normalizeText(post.text).includes(input.contractAddress!.toLowerCase())));
  const websiteLinksTwitter = Boolean(providedHandle && websiteHandle && providedHandle.toLowerCase() === websiteHandle.toLowerCase());
  const bioLinksWebsite = Boolean(websiteDomain && (accountWebsiteDomain === websiteDomain || bioText.includes(websiteDomain)));
  const accountAge = accountAgeDays(data?.account, now);
  const sameHandle = Boolean(providedHandle && providerHandle && providedHandle.toLowerCase() === providerHandle.toLowerCase());
  let confidence = 0.18;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (providedHandle) {
    confidence += 0.2;
    reasons.push("User-provided X/Twitter URL or handle was used directly.");
  }

  if (websiteHandle) {
    confidence += 0.2;
    reasons.push("Project website links to an X/Twitter account.");
  }

  if (sameHandle || websiteLinksTwitter) {
    confidence += 0.18;
    reasons.push("Website and fetched/provider account handles match.");
  }

  if (bioLinksWebsite) {
    confidence += 0.16;
    reasons.push("X bio/profile links back to the project website domain.");
  }

  if (contractMentioned) {
    confidence += 0.18;
    reasons.push("Contract address appears in official account posts.");
  }

  if (data?.account?.verified) {
    confidence += 0.06;
    reasons.push("Account has provider-reported verification.");
  }

  if (!providedHandle && !websiteHandle && input.symbol && !input.tokenName && !input.contractAddress) {
    confidence = Math.min(confidence, 0.28);
    warnings.push("Only symbol/query identity is available; symbol collisions are likely.");
  }

  if (providedHandle && providerHandle && providedHandle.toLowerCase() !== providerHandle.toLowerCase()) {
    confidence -= 0.22;
    warnings.push("Provided X handle does not match provider account handle.");
  }

  if (websiteDomain && accountWebsiteDomain && websiteDomain !== accountWebsiteDomain) {
    confidence -= 0.18;
    warnings.push("Website domain and X profile website domain do not match.");
  }

  if (typeof accountAge === "number" && accountAge < 30) {
    confidence -= 0.12;
    warnings.push("X account is very new.");
  }

  return {
    handle,
    accountProfile,
    confidence: clampScore(confidence * 100) / 100,
    reasons,
    warnings,
    websiteLinksTwitter,
    bioLinksWebsite,
    contractMentioned,
    accountAgeDays: accountAge,
  };
}

function getMandatorySocialResolverReport(input: SocialAgentInput, identity: ReturnType<typeof resolveOfficialIdentity>) {
  return {
    userProvidedHandle: getTwitterHandle(input.twitterUrl, input.query),
    websiteLinkedHandle: identity.websiteLinksTwitter ? identity.handle : undefined,
    dexScreenerLinkedHandle: input.dexScreenerPairUrl ? "requires_dex_metadata_provider" : undefined,
    directoryLinkedHandle: input.coingeckoId ? "requires_directory_metadata_provider" : undefined,
    mutualVerificationScore: identity.confidence,
    requiredForHoldConfidence: true,
  };
}

function getImpersonationRisk(input: SocialAgentInput, identity: ReturnType<typeof resolveOfficialIdentity>, data?: SocialProviderData) {
  const provided = getTwitterHandle(input.twitterUrl, input.query)?.toLowerCase();
  const provider = data?.account?.handle?.toLowerCase();
  const similarHandle = Boolean(provided && provider && provided !== provider && (provided.includes(provider) || provider.includes(provided)));
  const recentlyCreated = typeof identity.accountAgeDays === "number" && identity.accountAgeDays < 30;
  const followerMismatch = Boolean(data?.account && (data.account.followers ?? 0) < 250 && (data.account.postCount ?? 0) > 100);
  const fakeVerifiedStyle = /official|support|airdrop|claim/i.test(`${data?.account?.displayName ?? ""} ${data?.account?.handle ?? ""}`) && !data?.account?.verified;
  const domainMismatch = identity.warnings.some((warning) => warning.toLowerCase().includes("domain"));
  const riskScore = clampScore((similarHandle ? 28 : 0) + (recentlyCreated ? 26 : 0) + (followerMismatch ? 18 : 0) + (fakeVerifiedStyle ? 22 : 0) + (domainMismatch ? 24 : 0));

  return {
    similarHandle,
    recentlyCreated,
    followerMismatch,
    fakeVerifiedStyle,
    domainMismatch,
    riskScore,
  };
}

function collectPostLinks(metadata: SocialMetadata[], data?: SocialProviderData) {
  const posts = [...(data?.officialPosts ?? []), ...(data?.searchPosts ?? [])];
  const replyLinks = [...(data?.replies ?? []), ...posts.flatMap((post) => post.replies ?? [])].flatMap((reply) => {
    const matches = reply.text.match(/https?:\/\/[^\s)]+/gi);

    return matches ?? [];
  });

  return [
    ...metadata.flatMap((item) => item.links),
    ...posts.flatMap((post) => [post.url, ...(post.links ?? []), ...(post.text.match(/https?:\/\/[^\s)]+/gi) ?? [])].filter((value): value is string => Boolean(value))),
    ...replyLinks,
  ].map((url) => normalizeUrl(url)).filter((url): url is string => Boolean(url));
}

function getLinkSafety(input: SocialAgentInput, metadata: SocialMetadata[], data?: SocialProviderData): LinkSafetySummary {
  const links = collectPostLinks(metadata, data);
  const officialDomains = Array.from(new Set([getDomain(input.websiteUrl), getDomain(input.twitterUrl), getDomain(input.telegramUrl), getDomain(input.discordUrl)].filter((domain): domain is string => Boolean(domain))));
  const suspiciousLinks = links.filter((link) => {
    const text = normalizeText(link);

    return phishingKeywords.some((keyword) => text.includes(keyword)) || scamKeywords.some((keyword) => text.includes(keyword));
  });
  const mismatchedLinks = links.filter((link) => {
    const domain = getDomain(link);

    if (!domain || officialDomains.length === 0) return false;
    if (domain.includes("x.com") || domain.includes("twitter.com") || domain.includes("t.me") || domain.includes("discord.")) return false;

    return !officialDomains.includes(domain);
  });
  const riskScore = clampScore(suspiciousLinks.length * 34 + mismatchedLinks.length * 12);

  return {
    linksChecked: links.length,
    suspiciousLinks: Array.from(new Set(suspiciousLinks)).slice(0, 8),
    mismatchedLinks: Array.from(new Set(mismatchedLinks)).slice(0, 8),
    officialDomains,
    riskScore,
  };
}

function getPhishingScanner(input: SocialAgentInput, metadata: SocialMetadata[], data?: SocialProviderData) {
  const links = collectPostLinks(metadata, data);
  const websiteDomain = getDomain(input.websiteUrl);
  const scans = links.map((link) => {
    const text = normalizeText(link);
    const safety = evaluateUrlSafety(link, websiteDomain);

    return {
      link,
      claimOrAirdropLanguage: phishingKeywords.some((keyword) => text.includes(keyword)),
      drainerDomain: text.includes("drainer") || text.includes("claim") || text.includes("wallet"),
      shortenedUrl: /bit\.ly|t\.co|tinyurl|goo\.gl|linktr\.ee/i.test(link),
      suspiciousRedirectChain: !safety.safe,
      walletConnectionPromptRisk: text.includes("connect") || text.includes("wallet"),
      issues: safety.issues,
    };
  });

  return {
    linksChecked: scans.length,
    riskyLinks: scans.filter((scan) => scan.claimOrAirdropLanguage || scan.drainerDomain || scan.shortenedUrl || scan.suspiciousRedirectChain || scan.walletConnectionPromptRisk).slice(0, 10),
  };
}

function getEngagementRisk(data?: SocialProviderData) {
  const account = data?.account;
  const posts = [...(data?.officialPosts ?? []), ...(data?.searchPosts ?? [])];

  if (!account || posts.length === 0) {
    return {
      available: false,
      riskScore: 58,
      detail: "Live follower, like, view and reply metrics are unavailable. No engagement values were invented.",
    };
  }

  const followerCount = account.followers ?? 0;
  const averageViews = average(posts.map((post) => post.viewCount ?? 0).filter((value) => value > 0));
  const averageLikes = average(posts.map((post) => post.likeCount ?? 0));
  const averageReplies = average(posts.map((post) => post.replyCount ?? 0));
  const averageEngagement = averageViews > 0 ? (averageLikes + averageReplies) / averageViews : followerCount > 0 ? (averageLikes + averageReplies) / followerCount : 0;
  const followerPostRatio = account.postCount && account.postCount > 0 ? followerCount / account.postCount : 0;
  const riskScore = clampScore(
    (followerCount < 250 ? 28 : 0) +
      (averageEngagement > 0 && averageEngagement < 0.001 ? 24 : 0) +
      (averageReplies === 0 ? 12 : 0) +
      (followerPostRatio > 0 && followerPostRatio < 0.3 ? 16 : 0),
  );

  return {
    available: true,
    riskScore,
    detail: `Followers ${followerCount.toLocaleString("en-US")}, avg likes ${averageLikes.toFixed(1)}, avg replies ${averageReplies.toFixed(1)}, engagement ratio ${averageEngagement.toFixed(4)}.`,
  };
}

function average(values: number[]) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function getBotShillSummary(data: SocialProviderData | undefined, now: Date): BotShillSummary {
  const posts = [...(data?.officialPosts ?? []), ...(data?.searchPosts ?? [])];
  const replies = [...(data?.replies ?? []), ...posts.flatMap((post) => post.replies ?? [])];
  const texts = [...posts.map((post) => post.text), ...replies.map((reply) => reply.text)].map(normalizeText).filter(Boolean);
  const counts = new Map<string, number>();

  for (const text of texts) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }

  const repeatedTextGroups = Array.from(counts.values()).filter((count) => count >= 3).length;
  const lowQualityReplyCount = replies.filter((reply) => normalizeText(reply.text).length < 24 || countMatches(normalizeText(reply.text), phishingKeywords) > 0).length;
  const hypePostCount = posts.filter((post) => countMatches(normalizeText(post.text), ["100x", "1000x", "moon", "pump", "guaranteed", "free"]) > 0).length;
  const newReplyAccountCount = replies.filter((reply) => {
    if (!reply.authorCreatedAt) return false;
    const createdAt = new Date(reply.authorCreatedAt);

    return !Number.isNaN(createdAt.getTime()) && now.getTime() - createdAt.getTime() < 30 * 86_400_000;
  }).length;

  return {
    repeatedTextGroups,
    lowQualityReplyCount,
    hypePostCount,
    newReplyAccountCount,
    riskScore: clampScore(repeatedTextGroups * 24 + lowQualityReplyCount * 8 + hypePostCount * 12 + newReplyAccountCount * 10),
  };
}

function getMeasurableBotScore(data: SocialProviderData | undefined, now: Date) {
  const posts = [...(data?.officialPosts ?? []), ...(data?.searchPosts ?? [])];
  const replies = [...(data?.replies ?? []), ...posts.flatMap((post) => post.replies ?? [])];
  const texts = replies.map((reply) => normalizeText(reply.text)).filter(Boolean);
  const duplicateReplyRatio = texts.length > 0 ? 1 - new Set(texts).size / texts.length : undefined;
  const newAccountRatio = replies.length > 0 ? replies.filter((reply) => {
    if (!reply.authorCreatedAt) return false;
    const createdAt = new Date(reply.authorCreatedAt);

    return !Number.isNaN(createdAt.getTime()) && now.getTime() - createdAt.getTime() < 30 * 86_400_000;
  }).length / replies.length : undefined;
  const repeatedPhraseRatio = texts.length > 0 ? texts.filter((text) => countMatches(text, ["100x", "moon", "pump", "guaranteed", "airdrop"]) > 0).length / texts.length : undefined;
  const positiveOnlyReplyRatio = texts.length > 0 ? texts.filter((text) => countMatches(text, ["great", "bullish", "moon", "gem", "100x"]) > 0 && countMatches(text, complaintKeywords) === 0).length / texts.length : undefined;
  const engagementAnomalyScore = clampScore(
    ((duplicateReplyRatio ?? 0) * 35) +
      ((newAccountRatio ?? 0) * 25) +
      ((repeatedPhraseRatio ?? 0) * 20) +
      ((positiveOnlyReplyRatio ?? 0) * 20),
  );

  return {
    available: replies.length > 0,
    duplicateReplyRatio,
    newAccountRatio,
    repeatedPhraseRatio,
    positiveOnlyReplyRatio,
    engagementAnomalyScore,
  };
}

function getSocialSourceLimitations(providerDataAvailable: boolean, botScore: ReturnType<typeof getMeasurableBotScore>) {
  return {
    xApiMetricsAvailable: Boolean(process.env.X_BEARER_TOKEN),
    fakeMetricsGenerated: false,
    searchFallbackConfidenceCap: providerDataAvailable ? undefined : 0.48,
    commentsOrRepliesAvailable: botScore.available,
    botScoreStatus: botScore.available ? "available" : "unavailable",
  };
}

function getCommunitySubstanceRisk(text: string) {
  const qualityCount = countMatches(text, qualityKeywords);
  const supportCount = countMatches(text, supportKeywords);

  return {
    qualityCount,
    supportCount,
    riskScore: qualityCount + supportCount >= 5 ? 8 : qualityCount + supportCount >= 2 ? 30 : 68,
  };
}

function getNegativeCommunityRisk(text: string) {
  const complaintCount = countMatches(text, complaintKeywords);

  return {
    complaintCount,
    riskScore: complaintCount >= 3 ? 82 : complaintCount >= 1 ? 58 : 8,
  };
}

function getSourceCoverage(metadata: SocialMetadata[], data?: SocialProviderData) {
  const providerSources = getProviderHealthSources();
  const connectedProviderCount = providerSources.filter((source) => source.status === "connected").length;
  const connectedMetadataCount = metadata.length;
  const hasProviderData = Boolean(data?.account || data?.officialPosts?.length || data?.searchPosts?.length || data?.replies?.length);

  return {
    connectedProviderCount,
    connectedMetadataCount,
    hasProviderData,
    riskScore: hasProviderData ? 10 : connectedMetadataCount > 0 ? 42 : 70,
  };
}

function getSocialScore(input: {
  identityConfidence: number;
  engagementRisk: number;
  scamPhishingRisk: number;
  botShillRisk: number;
  communitySubstanceRisk: number;
  sourceCoverageRisk: number;
}) {
  const identityRisk = 100 - input.identityConfidence * 100;

  return clampScore(
    identityRisk * 0.25 +
      input.engagementRisk * 0.25 +
      input.scamPhishingRisk * 0.2 +
      input.botShillRisk * 0.15 +
      input.communitySubstanceRisk * 0.1 +
      input.sourceCoverageRisk * 0.05,
  );
}

function getRecommendedAction(score: number, criticalOverride: boolean, providerDataAvailable: boolean) {
  if (criticalOverride) return "avoid";
  if (score >= 75) return "manual_review";
  if (score >= 50) return "manual_review";
  if (!providerDataAvailable) return "watch";
  if (score >= 25) return "watch";

  return "hold";
}

function buildFindings(input: {
  identity: ReturnType<typeof resolveOfficialIdentity>;
  text: string;
  engagement: ReturnType<typeof getEngagementRisk>;
  linkSafety: LinkSafetySummary;
  botShill: BotShillSummary;
  measurableBotScore: ReturnType<typeof getMeasurableBotScore>;
  phishingScanner: ReturnType<typeof getPhishingScanner>;
  impersonation: ReturnType<typeof getImpersonationRisk>;
  limitations: ReturnType<typeof getSocialSourceLimitations>;
  communitySubstance: ReturnType<typeof getCommunitySubstanceRisk>;
  negativeCommunity: ReturnType<typeof getNegativeCommunityRisk>;
  coverage: ReturnType<typeof getSourceCoverage>;
  score: number;
  providerData?: SocialProviderData;
}): AgentFinding[] {
  const scamPhishingCount = countMatches(input.text, [...phishingKeywords, ...scamKeywords]);
  const providerPosts = [...(input.providerData?.officialPosts ?? []), ...(input.providerData?.searchPosts ?? [])];
  const suspiciousPosts = providerPosts.filter((post) => countMatches(normalizeText(post.text), [...phishingKeywords, ...scamKeywords, ...complaintKeywords]) > 0);
  const criticalLink = input.linkSafety.suspiciousLinks.some((link) => normalizeText(link).includes("drainer") || normalizeText(link).includes("claim") || normalizeText(link).includes("connect"));
  const mismatchSeverity = input.identity.warnings.some((warning) => warning.toLowerCase().includes("domain")) ? "high" : "low";
  const contractMismatch = Boolean(input.providerData?.officialPosts?.some((post) => normalizeText(post.text).includes("contract mismatch")));

  return [
    {
      label: "Mandatory official social resolver",
      severity: input.identity.confidence >= 0.75 ? "low" : input.identity.confidence >= 0.45 ? "medium" : "high",
      scoreImpact: clampScore(100 - input.identity.confidence * 100),
      detail: "Resolver requires user-provided handle, website-linked handle, directory/DexScreener-linked handle, and mutual verification before strong confidence.",
      raw: JSON.stringify(input.identity),
    },
    {
      label: "Impersonation detector",
      severity: severityForScore(input.impersonation.riskScore),
      scoreImpact: input.impersonation.riskScore,
      detail: `Similar handle ${input.impersonation.similarHandle ? "yes" : "no"}, new account ${input.impersonation.recentlyCreated ? "yes" : "no"}, follower mismatch ${input.impersonation.followerMismatch ? "yes" : "no"}, fake verified-style naming ${input.impersonation.fakeVerifiedStyle ? "yes" : "no"}, domain mismatch ${input.impersonation.domainMismatch ? "yes" : "no"}.`,
      raw: JSON.stringify(input.impersonation),
    },
    {
      label: "Phishing link scanner",
      severity: input.phishingScanner.riskyLinks.length > 0 ? "critical" : "low",
      scoreImpact: input.phishingScanner.riskyLinks.length > 0 ? 88 : 8,
      detail: `${input.phishingScanner.linksChecked} link${input.phishingScanner.linksChecked === 1 ? "" : "s"} scanned for claim/airdrop/connect-wallet language, drainer domains, shortened URLs and suspicious redirects.`,
      raw: JSON.stringify(input.phishingScanner),
    },
    {
      label: "Measurable bot/shill score",
      severity: input.measurableBotScore.available ? severityForScore(input.measurableBotScore.engagementAnomalyScore) : "medium",
      scoreImpact: input.measurableBotScore.engagementAnomalyScore,
      detail: input.measurableBotScore.available
        ? `Duplicate reply ratio ${(input.measurableBotScore.duplicateReplyRatio ?? 0).toFixed(2)}, new account ratio ${(input.measurableBotScore.newAccountRatio ?? 0).toFixed(2)}, repeated phrase ratio ${(input.measurableBotScore.repeatedPhraseRatio ?? 0).toFixed(2)}, positive-only ratio ${(input.measurableBotScore.positiveOnlyReplyRatio ?? 0).toFixed(2)}.`
        : "Comments/replies unavailable, so bot score is marked unavailable instead of fabricated.",
      raw: JSON.stringify(input.measurableBotScore),
    },
    {
      label: "Social source limitations",
      severity: input.limitations.botScoreStatus === "unavailable" || !input.limitations.xApiMetricsAvailable ? "medium" : "low",
      scoreImpact: input.limitations.botScoreStatus === "unavailable" ? 42 : 10,
      detail: `X API metrics available ${input.limitations.xApiMetricsAvailable ? "yes" : "no"}; fake metrics generated ${input.limitations.fakeMetricsGenerated ? "yes" : "no"}; bot score ${input.limitations.botScoreStatus}.`,
      raw: JSON.stringify(input.limitations),
    },
    {
      label: "Official account confidence",
      severity: input.identity.confidence >= 0.75 ? "low" : input.identity.confidence >= 0.45 ? "medium" : "high",
      scoreImpact: clampScore(100 - input.identity.confidence * 100),
      detail: `Official account confidence is ${Math.round(input.identity.confidence * 100)}%. ${input.identity.reasons.concat(input.identity.warnings).join(" ") || "No strong official social identity evidence was found."}`,
    },
    {
      label: "Social identity mismatch",
      severity: mismatchSeverity,
      scoreImpact: mismatchSeverity === "high" ? 68 : 8,
      detail: input.identity.warnings.length > 0 ? input.identity.warnings.join(" ") : "No website/X identity mismatch was detected from available sources.",
    },
    {
      label: "Phishing and giveaway language",
      severity: criticalLink ? "critical" : severityForScore(clampScore(scamPhishingCount * 18 + input.linkSafety.riskScore)),
      scoreImpact: clampScore(scamPhishingCount * 18 + input.linkSafety.riskScore),
      detail: `${scamPhishingCount} phishing/scam/hype keyword${scamPhishingCount === 1 ? "" : "s"} found across metadata, posts and replies.`,
    },
    {
      label: "Engagement quality",
      severity: input.engagement.available ? severityForScore(input.engagement.riskScore) : "medium",
      scoreImpact: input.engagement.riskScore,
      detail: input.engagement.detail,
    },
    {
      label: "Bot/shill density",
      severity: severityForScore(input.botShill.riskScore),
      scoreImpact: input.botShill.riskScore,
      detail: `${input.botShill.repeatedTextGroups} repeated text group${input.botShill.repeatedTextGroups === 1 ? "" : "s"}, ${input.botShill.lowQualityReplyCount} low-quality replies, ${input.botShill.hypePostCount} hype-heavy posts, ${input.botShill.newReplyAccountCount} very new reply accounts.`,
    },
    {
      label: "Community substance",
      severity: severityForScore(input.communitySubstance.riskScore),
      scoreImpact: input.communitySubstance.riskScore,
      detail: `${input.communitySubstance.qualityCount} docs/audit/github/roadmap/technical signal${input.communitySubstance.qualityCount === 1 ? "" : "s"} and ${input.communitySubstance.supportCount} team update/support signal${input.communitySubstance.supportCount === 1 ? "" : "s"} found.`,
    },
    {
      label: "Negative community signals",
      severity: contractMismatch ? "critical" : severityForScore(input.negativeCommunity.riskScore),
      scoreImpact: contractMismatch ? 94 : input.negativeCommunity.riskScore,
      detail: `${input.negativeCommunity.complaintCount} complaint/scam/withdrawal/sell/contract-mismatch signal${input.negativeCommunity.complaintCount === 1 ? "" : "s"} found.`,
    },
    {
      label: "Link safety summary",
      severity: severityForScore(input.linkSafety.riskScore),
      scoreImpact: input.linkSafety.riskScore,
      detail: `${input.linkSafety.linksChecked} link${input.linkSafety.linksChecked === 1 ? "" : "s"} checked; ${input.linkSafety.suspiciousLinks.length} suspicious and ${input.linkSafety.mismatchedLinks.length} domain-mismatched link${input.linkSafety.mismatchedLinks.length === 1 ? "" : "s"} found.`,
      raw: JSON.stringify(input.linkSafety),
    },
    {
      label: "Matched social posts",
      severity: providerPosts.length > 0 ? "low" : "medium",
      scoreImpact: providerPosts.length > 0 ? 8 : 42,
      detail: `${providerPosts.length} provider post${providerPosts.length === 1 ? "" : "s"} matched the official or search identity; ${suspiciousPosts.length} suspicious post${suspiciousPosts.length === 1 ? "" : "s"} highlighted.`,
    },
    {
      label: "Source coverage",
      severity: severityForScore(input.coverage.riskScore),
      scoreImpact: input.coverage.riskScore,
      detail: `${input.coverage.connectedMetadataCount} metadata source${input.coverage.connectedMetadataCount === 1 ? "" : "s"}, ${input.coverage.connectedProviderCount} configured live provider${input.coverage.connectedProviderCount === 1 ? "" : "s"}, provider data ${input.coverage.hasProviderData ? "available" : "unavailable"}.`,
    },
    {
      label: "Social risk formula",
      severity: severityForScore(input.score),
      scoreImpact: input.score,
      detail: "Score uses 25% identity verification, 25% engagement quality, 20% scam/phishing language, 15% bot/shill density, 10% community substance and 5% source coverage.",
    },
  ];
}

export async function runSocialAgent(input: SocialAgentInput, providers: SocialAgentProviders = {}): Promise<AgentResult> {
  const now = providers.now ?? new Date();
  const fetchPublicMetadata = providers.fetchMetadata ?? fetchMetadata;
  const fetchProviderData = providers.fetchSocialData ?? fetchSocialProviderData;
  const urls = getCandidateUrls(input);
  const metadataResults = await Promise.allSettled(urls.map(fetchPublicMetadata));
  const metadata = metadataResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const initialHandle = getTwitterHandle(input.twitterUrl, input.query);
  const providerData = await fetchProviderData(input, initialHandle).catch(() => undefined);
  const identity = resolveOfficialIdentity(input, metadata, providerData, now);
  const text = getAllText(metadata, providerData);
  const linkSafety = getLinkSafety(input, metadata, providerData);
  const phishingScanner = getPhishingScanner(input, metadata, providerData);
  const engagement = getEngagementRisk(providerData);
  const botShill = getBotShillSummary(providerData, now);
  const measurableBotScore = getMeasurableBotScore(providerData, now);
  const communitySubstance = getCommunitySubstanceRisk(text);
  const negativeCommunity = getNegativeCommunityRisk(text);
  const coverage = getSourceCoverage(metadata, providerData);
  const scamPhishingRisk = clampScore(countMatches(text, [...phishingKeywords, ...scamKeywords]) * 18 + linkSafety.riskScore);
  const score = getSocialScore({
    identityConfidence: identity.confidence,
    engagementRisk: engagement.riskScore,
    scamPhishingRisk,
    botShillRisk: botShill.riskScore,
    communitySubstanceRisk: communitySubstance.riskScore,
    sourceCoverageRisk: coverage.riskScore,
  });
  const providerDataAvailable = Boolean(providerData?.account || providerData?.officialPosts?.length || providerData?.searchPosts?.length || providerData?.replies?.length);
  const officialPhishing = identity.confidence >= 0.45 && linkSafety.suspiciousLinks.length > 0;
  const impersonation = getImpersonationRisk(input, identity, providerData);
  const limitations = getSocialSourceLimitations(providerDataAvailable, measurableBotScore);
  const criticalOverride = officialPhishing || negativeCommunity.riskScore >= 82;
  const recommendedAction = getRecommendedAction(score, criticalOverride, providerDataAvailable);
  const findings = buildFindings({
    identity,
    text,
    engagement,
    linkSafety,
    botShill,
    measurableBotScore,
    phishingScanner,
    impersonation,
    limitations,
    communitySubstance,
    negativeCommunity,
    coverage,
    score,
    providerData,
  });
  const checkedAt = now.toISOString();
  const metadataSources = urls.map((url, index): AgentSource => {
    const connected = metadataResults[index]?.status === "fulfilled";

    return {
      label: url.includes("twitter.com") || url.includes("x.com") ? "X/Twitter metadata" : url.includes("t.me") ? "Telegram metadata" : url.includes("discord.") ? "Discord metadata" : "Website metadata",
      url,
      status: connected ? "connected" : "unavailable",
      detail: connected ? "Public metadata fetched." : "Metadata unavailable or blocked.",
      checkedAt,
      reliability: connected ? 0.44 : 0.1,
    };
  });
  const providerSources = getProviderHealthSources().map((source) => ({
    ...source,
    status: providerDataAvailable && (source.status === "connected" || source.label === providerData?.providerLabel) ? "connected" : source.status,
    checkedAt,
  }));
  const matchedPostSources: AgentSource[] = [...(providerData?.officialPosts ?? []), ...(providerData?.searchPosts ?? [])].slice(0, 8).map((post) => ({
    label: `Social post: ${post.text.slice(0, 72)}`,
    url: post.url,
    status: "connected",
    detail: post.createdAt ? `Matched social post from ${post.createdAt}.` : "Matched social post from provider data.",
    checkedAt,
    reliability: 0.58,
  }));

  return buildAgentResult({
    agent: "social",
    score,
    verdict:
      criticalOverride || score >= 75
        ? "Critical social risk needs review"
        : score >= 50
          ? "Social risk needs review"
          : score >= 25
            ? "Social signal incomplete"
            : "No major social risk",
    summary: providerDataAvailable
      ? `Social Agent checked ${metadata.length} metadata source${metadata.length === 1 ? "" : "s"} plus provider data for ${identity.handle ?? input.symbol ?? "the token"}.`
      : metadata.length > 0
        ? `Social Agent checked ${metadata.length} public metadata source${metadata.length === 1 ? "" : "s"}; live engagement provider data is unavailable.`
        : "Social Agent found no reachable metadata or provider data; this is missing coverage, not a safe signal.",
    findings,
    sources: [...metadataSources, ...providerSources, ...matchedPostSources],
    confidence: providerDataAvailable ? Math.min(0.76, 0.34 + identity.confidence * 0.32 + coverage.connectedMetadataCount * 0.06) : Math.min(0.48, 0.22 + coverage.connectedMetadataCount * 0.08),
    recommendedAction,
    blockingReasons: criticalOverride ? ["Critical social blocker detected: official-looking phishing link or severe negative community signal."] : [],
    missingData: providerDataAvailable
      ? []
      : [
          {
            field: "live social provider data",
            reason: "Follower, reply, engagement and bot metrics are unavailable.",
            impact: "medium",
            requiredFor: "social confidence",
          },
        ],
    rawSignals: {
      officialAccountConfidence: identity.confidence,
      mandatorySocialResolver: getMandatorySocialResolverReport(input, identity),
      impersonation,
      phishingScanner,
      measurableBotScore,
      limitations,
      identity,
      account: providerData?.account,
      matchedSocialPosts: [...(providerData?.officialPosts ?? []), ...(providerData?.searchPosts ?? [])],
      topSuspiciousPosts: [...(providerData?.officialPosts ?? []), ...(providerData?.searchPosts ?? [])]
        .filter((post) => countMatches(normalizeText(post.text), [...phishingKeywords, ...scamKeywords, ...complaintKeywords]) > 0)
        .slice(0, 5),
      sampledReplies: [...(providerData?.replies ?? []), ...(providerData?.officialPosts ?? []).flatMap((post) => post.replies ?? [])].slice(0, 20),
      engagement,
      botShillSummary: botShill,
      linkSafetySummary: linkSafety,
      communitySubstance,
      negativeCommunity,
      sourceCoverage: coverage,
      providerDataAvailable,
    },
  });
}
