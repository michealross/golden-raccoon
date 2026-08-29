import "server-only";

import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";
import type {
  PortfolioSnapshot,
  StellarPortfolioActivity,
} from "@/server/types";
import type { StellarNetworkConfig } from "@/lib/stellar/config";
import {
  canonicalClassicAssetKey,
  canonicalContractAssetKey,
} from "@/server/stellar/assetIdentity";
import {
  createStellarDataServer,
  createStellarRpcServer,
} from "@/server/stellar/client";
import {
  buildStellarPortfolioSnapshot,
  stellarPortfolioCacheKey,
  type StellarPortfolioHoldingInput,
} from "@/server/stellar/portfolioModel";

const officialUsdcIssuers = {
  "stellar-testnet":
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "stellar-pubnet":
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
} as const;

const CACHE_TTL_MS = 30_000;
const portfolioCache = new Map<
  string,
  { expiresAt: number; value: PortfolioSnapshot }
>();

type HorizonBalance = {
  asset_type: string;
  balance: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  asset_code?: string;
  asset_issuer?: string;
  is_authorized?: boolean;
  is_clawback_enabled?: boolean;
};

type HorizonAccount = {
  balances: HorizonBalance[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  flags?: {
    auth_required?: boolean;
    auth_revocable?: boolean;
    auth_clawback_enabled?: boolean;
  };
};

type HorizonLedgerRecord = {
  base_reserve_in_stroops?: number | string;
};

type HorizonOperationRecord = {
  id: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  asset_code?: string;
  source_asset_code?: string;
  amount?: string;
  source_amount?: string;
};

type ConfiguredContractToken = {
  network: "stellar-testnet" | "stellar-pubnet";
  kind: "sac" | "sep41";
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  issuer?: string;
  verified?: boolean;
  priceUsd?: number;
  priceSource?: string;
  authorizationRequired?: boolean;
  revocable?: boolean;
  clawbackEnabled?: boolean;
};

type IssuerFlags = NonNullable<HorizonAccount["flags"]>;

function parseConfiguredContractTokens(): ConfiguredContractToken[] {
  const raw = process.env.STELLAR_PORTFOLIO_TOKENS_JSON;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is ConfiguredContractToken => {
      if (!entry || typeof entry !== "object") return false;
      const token = entry as Partial<ConfiguredContractToken>;
      return (
        ["stellar-testnet", "stellar-pubnet"].includes(token.network ?? "") &&
        ["sac", "sep41"].includes(token.kind ?? "") &&
        typeof token.contractId === "string" &&
        StrKey.isValidContract(token.contractId) &&
        typeof token.symbol === "string" &&
        typeof token.name === "string" &&
        Number.isInteger(token.decimals) &&
        Number(token.decimals) >= 0 &&
        Number(token.decimals) <= 18
      );
    });
  } catch {
    return [];
  }
}

async function getXlmPrice() {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd&include_24hr_change=true",
    {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8_000),
    },
  );

  if (!response.ok) return null;

  const payload = (await response.json()) as {
    stellar?: { usd?: number; usd_24h_change?: number };
  };

  return typeof payload.stellar?.usd === "number" ? payload.stellar : null;
}

function classifyActivity(
  operation: HorizonOperationRecord,
): StellarPortfolioActivity | null {
  const type =
    operation.type === "payment"
      ? "payment"
      : ["path_payment_strict_receive", "path_payment_strict_send"].includes(
            operation.type,
          )
        ? "swap"
        : [
              "change_trust",
              "allow_trust",
              "set_trust_line_flags",
            ].includes(operation.type)
          ? "trustline_change"
          : operation.type === "invoke_host_function"
            ? "contract_call"
            : null;

  if (!type) return null;

  return {
    id: operation.id,
    type,
    createdAt: operation.created_at,
    transactionHash: operation.transaction_hash,
    asset: operation.asset_code ?? operation.source_asset_code,
    amount: operation.amount ?? operation.source_amount,
  };
}

function formatContractBalance(value: unknown, decimals: number) {
  const raw =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isInteger(value)
        ? BigInt(value)
        : null;
  if (raw === null) return null;

  const negative = raw < 0;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return `${negative ? "-" : ""}${digits}`;
  const integer = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");

  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

async function loadConfiguredContractHolding(
  token: ConfiguredContractToken,
  walletAddress: string,
  network: StellarNetworkConfig,
  rpcServer: ReturnType<typeof createStellarRpcServer>["server"],
  issuerFlags: IssuerFlags | null,
): Promise<StellarPortfolioHoldingInput | null> {
  const source = await rpcServer.getAccount(walletAddress);
  const contract = new Contract(token.contractId);
  const simulate = async (method: string) => {
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: network.networkPassphrase,
    })
      .addOperation(
        contract.call(method, new Address(walletAddress).toScVal()),
      )
      .setTimeout(30)
      .build();

    return rpcServer.simulateTransaction(transaction);
  };
  const simulation = await simulate("balance");

  if (!("result" in simulation) || !simulation.result?.retval) return null;
  const balance = formatContractBalance(
    scValToNative(simulation.result.retval),
    token.decimals,
  );
  if (balance === null) return null;
  let authorized = true;
  let authorizationReadComplete = token.kind !== "sac";

  if (token.kind === "sac") {
    try {
      const authorization = await simulate("authorized");
      if ("result" in authorization && authorization.result?.retval) {
        const value = scValToNative(authorization.result.retval);
        if (typeof value === "boolean") {
          authorized = value;
          authorizationReadComplete = true;
        }
      }
    } catch {
      authorizationReadComplete = false;
    }
  }
  const sacIssuerDataComplete =
    token.kind !== "sac" ||
    (Boolean(token.issuer) &&
      issuerFlags !== null &&
      authorizationReadComplete);

  return {
    assetKind: token.kind,
    assetKey: canonicalContractAssetKey(token.contractId),
    symbol: token.symbol.toUpperCase(),
    name: token.name,
    balance,
    issuer: token.issuer?.toUpperCase(),
    contractId: token.contractId.toUpperCase(),
    authorized,
    authorizationRequired:
      issuerFlags?.auth_required ?? token.authorizationRequired ?? false,
    revocable: issuerFlags?.auth_revocable ?? token.revocable ?? false,
    clawbackEnabled:
      issuerFlags?.auth_clawback_enabled ?? token.clawbackEnabled ?? false,
    riskDataComplete: sacIssuerDataComplete,
    verified: token.verified === true,
    priceUsd:
      typeof token.priceUsd === "number" && token.priceUsd > 0
        ? token.priceUsd
        : null,
    priceSource: token.priceSource,
  };
}

async function loadIssuerFlags(
  issuers: string[],
  loadAccount: (address: string) => Promise<HorizonAccount>,
) {
  const entries = await Promise.all(
    [...new Set(issuers)].map(async (issuer) => {
      try {
        const account = await loadAccount(issuer);
        return [issuer, account.flags ?? {}] as const;
      } catch {
        return [issuer, null] as const;
      }
    }),
  );

  return new Map(entries);
}

async function loadPortfolio(
  walletAddress: string,
  networkId: string,
): Promise<PortfolioSnapshot | null> {
  const canonicalWallet = walletAddress.toUpperCase();
  const { network, server: dataServer } = createStellarDataServer(networkId);
  const { server: rpcServer } = createStellarRpcServer(networkId);
  const startedAt = performance.now();
  const [
    accountResult,
    rpcAccountResult,
    ledgerResult,
    activityResult,
    xlmPriceResult,
  ] = await Promise.allSettled([
    dataServer.loadAccount(canonicalWallet) as Promise<HorizonAccount>,
    rpcServer.getAccount(canonicalWallet),
    dataServer.ledgers().order("desc").limit(1).call(),
    dataServer
      .operations()
      .forAccount(canonicalWallet)
      .order("desc")
      .limit(30)
      .call(),
    getXlmPrice(),
  ]);

  if (
    accountResult.status !== "fulfilled" ||
    rpcAccountResult.status !== "fulfilled"
  ) {
    return null;
  }

  const account = accountResult.value;
  const xlmMarket =
    xlmPriceResult.status === "fulfilled" ? xlmPriceResult.value : null;
  const configuredTokens = parseConfiguredContractTokens().filter(
    (token) => token.network === network.id,
  );
  const issuerFlags = await loadIssuerFlags(
    [
      ...account.balances.map((balance) =>
        balance.asset_issuer?.toUpperCase(),
      ),
      ...configuredTokens.map((token) => token.issuer?.toUpperCase()),
    ].filter((issuer): issuer is string => Boolean(issuer)),
    (address) => dataServer.loadAccount(address) as Promise<HorizonAccount>,
  );
  const dataWarnings: string[] = [];
  for (const [issuer, flags] of issuerFlags) {
    if (flags === null) {
      dataWarnings.push(`Issuer risk flags unavailable for ${issuer}.`);
    }
  }
  const classicHoldings = account.balances.map(
    (balance): StellarPortfolioHoldingInput => {
      const native = balance.asset_type === "native";
      const code = native
        ? "XLM"
        : (balance.asset_code ?? "UNKNOWN").toUpperCase();
      const issuer = native
        ? undefined
        : balance.asset_issuer?.toUpperCase();
      const officialUsdc =
        code === "USDC" &&
        issuer === officialUsdcIssuers[network.id];
      const flags = issuer ? issuerFlags.get(issuer) : undefined;
      const asset = issuer ? new Asset(code, issuer) : null;

      return {
        assetKind: native ? "native" : "classic",
        assetKey: native
          ? "native"
          : canonicalClassicAssetKey(code, issuer ?? "unknown"),
        symbol: code,
        name: native
          ? "Stellar Lumens"
          : officialUsdc
            ? "USD Coin"
            : `${code} issued asset`,
        balance: balance.balance,
        buyingLiabilities: balance.buying_liabilities,
        sellingLiabilities: balance.selling_liabilities,
        issuer,
        contractId: asset?.contractId(network.networkPassphrase),
        authorized: balance.is_authorized !== false,
        authorizationRequired: flags?.auth_required === true,
        revocable: flags?.auth_revocable === true,
        clawbackEnabled:
          balance.is_clawback_enabled === true ||
          flags?.auth_clawback_enabled === true,
        riskDataComplete: native || flags !== null,
        verified: native || officialUsdc,
        priceUsd: native ? (xlmMarket?.usd ?? null) : officialUsdc ? 1 : null,
        priceSource: native
          ? xlmMarket
            ? "coingecko"
            : undefined
          : officialUsdc
            ? "official_stellar_usdc"
            : undefined,
      };
    },
  );
  const contractResults = await Promise.allSettled(
    configuredTokens.map((token) =>
      loadConfiguredContractHolding(
        token,
        canonicalWallet,
        network,
        rpcServer,
        token.issuer
          ? (issuerFlags.get(token.issuer.toUpperCase()) ?? null)
          : null,
      ),
    ),
  );
  const contractHoldings = contractResults.flatMap((result, index) => {
    if (result.status === "fulfilled" && result.value) return [result.value];
    dataWarnings.push(
      `Contract balance unavailable for ${configuredTokens[index]?.contractId ?? "configured token"}.`,
    );
    return [];
  });
  const ledgerRecord =
    ledgerResult.status === "fulfilled"
      ? (ledgerResult.value.records[0] as HorizonLedgerRecord | undefined)
      : undefined;
  const baseReserveStroops = Number(ledgerRecord?.base_reserve_in_stroops);
  if (
    !Number.isFinite(baseReserveStroops) ||
    baseReserveStroops <= 0
  ) {
    return null;
  }
  const recentActivity =
    activityResult.status === "fulfilled"
      ? activityResult.value.records
          .map((record) =>
            classifyActivity(record as unknown as HorizonOperationRecord),
          )
          .filter(
            (activity): activity is StellarPortfolioActivity =>
              activity !== null,
          )
      : [];
  if (activityResult.status !== "fulfilled") {
    dataWarnings.push("Recent Stellar activity is temporarily unavailable.");
  }

  return buildStellarPortfolioSnapshot({
    walletAddress: canonicalWallet,
    networkId: network.id,
    networkName: network.name,
    baseReserveStroops,
    account: {
      subentryCount: account.subentry_count,
      numSponsoring: account.num_sponsoring,
      numSponsored: account.num_sponsored,
    },
    holdings: [...classicHoldings, ...contractHoldings],
    recentActivity,
    xlmDayChangePercent: xlmMarket?.usd_24h_change,
    providerLatencyMs: Math.round(performance.now() - startedAt),
    dataWarnings,
  });
}

export async function getStellarPortfolio(
  walletAddress: string,
  networkId: string,
): Promise<PortfolioSnapshot | null> {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) return null;

  const key = stellarPortfolioCacheKey(walletAddress, networkId);
  const cached = portfolioCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const portfolio = await loadPortfolio(walletAddress, networkId);
  if (portfolio) {
    portfolioCache.set(key, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value: portfolio,
    });
  }

  return portfolio;
}
