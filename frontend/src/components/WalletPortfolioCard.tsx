import type { PortfolioSnapshot } from "@/server/types";
import { formatUsd, shortAddress } from "@/lib/format";
import { BadgeCheck } from "lucide-react";

type LogoFallback = {
  label: string;
  className: string;
  imageUrl?: string;
};

const tokenLogos: Record<string, LogoFallback> = {
  GOAT: {
    label: "G",
    className: "bg-[#d9a441] text-black",
    imageUrl: "/brand/logo.png",
  },
  USDC: {
    label: "$",
    className: "bg-[#2775ca] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
  },
  MEME: {
    label: "M",
    className: "bg-[#ff5f57] text-white",
  },
  SOL: {
    label: "S",
    className: "bg-[#14f195] text-black",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
  },
  ETH: {
    label: "E",
    className: "bg-white text-[#111]",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
  BTC: {
    label: "B",
    className: "bg-[#f7931a] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
  },
  BNB: {
    label: "B",
    className: "bg-[#f0b90b] text-black",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png",
  },
};

const chainLogos: Record<string, LogoFallback> = {
  ethereum: {
    label: "E",
    className: "bg-[#627eea] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
  "eth-mainnet": {
    label: "E",
    className: "bg-[#627eea] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
  base: {
    label: "B",
    className: "bg-[#0052ff] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png",
  },
  "base-mainnet": {
    label: "B",
    className: "bg-[#0052ff] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png",
  },
  arbitrum: {
    label: "A",
    className: "bg-[#213147] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png",
  },
  "arbitrum-mainnet": {
    label: "A",
    className: "bg-[#213147] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png",
  },
  "bnb chain": {
    label: "B",
    className: "bg-[#f0b90b] text-black",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png",
  },
  "bsc-mainnet": {
    label: "B",
    className: "bg-[#f0b90b] text-black",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png",
  },
  solana: {
    label: "S",
    className: "bg-[#14f195] text-black",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
  },
  "solana-mainnet": {
    label: "S",
    className: "bg-[#14f195] text-black",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
  },
  bitcoin: {
    label: "B",
    className: "bg-[#f7931a] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
  },
  "bitcoin-mainnet": {
    label: "B",
    className: "bg-[#f7931a] text-white",
    imageUrl: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
  },
};

function getFallbackLogo(symbol: string): LogoFallback {
  return (
    tokenLogos[symbol] ?? {
      label: symbol.slice(0, 1),
      className: "bg-white/12 text-white",
    }
  );
}

function getChainLogo(chainId?: string, chainName?: string): LogoFallback {
  const key = (chainId ?? chainName ?? "").toLowerCase();
  const nameKey = (chainName ?? "").toLowerCase();

  return (
    chainLogos[key] ??
    chainLogos[nameKey] ?? {
      label: (chainName ?? chainId ?? "?").slice(0, 1),
      className: "bg-white/18 text-white",
    }
  );
}

function getTokenLogoUrl(symbol: string, providerLogoUrl?: string) {
  return tokenLogos[symbol]?.imageUrl ?? providerLogoUrl;
}

function getChainLogoUrl(chainLogo: LogoFallback, providerLogoUrl?: string) {
  return chainLogo.imageUrl ?? providerLogoUrl;
}

function formatTokenBalance(value: number) {
  const maximumFractionDigits = value > 0 && value < 0.0001 ? 8 : value > 0 && value < 1 ? 6 : 4;

  return value.toLocaleString("en-US", {
    maximumFractionDigits,
  });
}

export function WalletPortfolioCard({
  portfolio,
  walletAddress,
}: {
  portfolio: PortfolioSnapshot;
  walletAddress?: string;
}) {
  const isDown = portfolio.dayChangePercent < 0;
  const signedChangeUsd =
    typeof portfolio.dayChangeUsd === "number"
      ? `${portfolio.dayChangeUsd >= 0 ? "+" : "-"}${formatUsd(Math.abs(portfolio.dayChangeUsd), {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      : null;
  const signedChangePercent = `${portfolio.dayChangePercent >= 0 ? "+" : ""}${portfolio.dayChangePercent.toFixed(2)}%`;

  return (
    <section className="glass-panel rounded-[28px] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm text-white/54">Wallet assets</div>
          <div className="mt-2 text-5xl font-semibold tracking-tight text-white">
            {formatUsd(portfolio.totalValueUsd, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          {portfolio.valuationStatus === "partial" ? (
            <div className="mt-2 text-xs text-amber-200">
              Partial valuation · {portfolio.unpricedAssetCount ?? 0} positive balance
              {(portfolio.unpricedAssetCount ?? 0) === 1 ? "" : "s"} without a trusted price
            </div>
          ) : null}
          {(portfolio.dataWarnings?.length ?? 0) > 0 ? (
            <div className="mt-1 text-xs text-amber-200">
              {portfolio.dataWarnings?.length} provider warning
              {portfolio.dataWarnings?.length === 1 ? "" : "s"}
            </div>
          ) : null}
          {typeof portfolio.spendableNativeBalance === "number" ? (
            <div className="mt-1 text-xs text-white/42">
              Spendable {portfolio.nativeSymbol}: {formatTokenBalance(portfolio.spendableNativeBalance)}
              {" · "}minimum reserve {formatTokenBalance(portfolio.minimumReserveXlm ?? 0)}
            </div>
          ) : null}
        </div>
        <div className="text-right text-sm">
          <div className="rounded-full border border-white/10 bg-white/7 px-3 py-1 text-white/56">
            {shortAddress(walletAddress ?? portfolio.walletAddress)}
          </div>
          <div className={isDown ? "mt-3 text-red-300" : "mt-3 text-emerald-300"}>
            {signedChangeUsd ? `${signedChangeUsd} (${signedChangePercent})` : signedChangePercent} 24h
          </div>
        </div>
      </div>

      <div className="mt-5 max-h-[18.5rem] space-y-3 overflow-y-auto pr-1 [scrollbar-color:rgba(255,255,255,.18)_transparent] [scrollbar-width:thin]">
        {portfolio.holdings.map((holding) => {
          const logo = getFallbackLogo(holding.symbol);
          const chainLogo = getChainLogo(holding.chainId, holding.chainName);
          const tokenLogoUrl = getTokenLogoUrl(holding.symbol, holding.logoUrl);
          const chainLogoUrl = getChainLogoUrl(chainLogo, holding.chainLogoUrl);

          return (
            <div
              key={`${holding.chainId ?? holding.chainName ?? "unknown"}:${holding.tokenAddress}`}
              className="flex min-h-[5.25rem] items-center justify-between gap-4 rounded-[24px] bg-white/[.065] px-4 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-4">
                <div className="relative h-14 w-14 shrink-0">
                  {tokenLogoUrl ? (
                    <div
                      className={`relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-full text-xl font-bold ${logo.className}`}
                      aria-label={`${holding.symbol} logo`}
                    >
                      <span>{logo.label}</span>
                      <span
                        className="absolute inset-0 rounded-full bg-white/10 bg-contain bg-center bg-no-repeat"
                        style={{ backgroundImage: `url(${tokenLogoUrl})` }}
                      />
                    </div>
                  ) : (
                    <div className={`flex h-14 w-14 items-center justify-center rounded-full text-xl font-bold ${logo.className}`}>
                      {logo.label}
                    </div>
                  )}
                  <div
                    className={`absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center overflow-hidden rounded-full border-2 border-[#222] text-[10px] font-bold ${chainLogo.className}`}
                    aria-label={`${holding.chainName ?? "Network"} logo`}
                  >
                    <span>{chainLogo.label}</span>
                    {chainLogoUrl ? (
                      <span
                        className="absolute inset-0 rounded-full bg-contain bg-center bg-no-repeat"
                        style={{ backgroundImage: `url(${chainLogoUrl})` }}
                      />
                    ) : null}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-lg font-semibold">{holding.symbol}</div>
                    {holding.isVerified ? <BadgeCheck className="h-5 w-5 shrink-0 fill-[#4f8cff] text-[#4f8cff]" /> : null}
                  </div>
                  <div className="mt-1 truncate text-sm text-white/48">
                    {formatTokenBalance(holding.balance)} {holding.symbol}
                  </div>
                  {holding.chainName ? (
                    <div className="mt-1 text-xs text-white/32">
                      {holding.chainName}
                      {holding.issuer
                        ? ` · issuer ${shortAddress(holding.issuer)}`
                        : holding.contractId
                          ? ` · issuer unavailable · contract ${shortAddress(holding.contractId)}`
                          : " · native issuer"}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="shrink-0 text-right">
                {holding.priceStatus === "unavailable" ? (
                  <div className="text-sm font-medium text-amber-200">Price unavailable</div>
                ) : (
                  <div className="text-lg font-semibold">
                    {formatUsd(holding.valueUsd, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                )}
                {holding.stellarRisk?.authorized === false ? (
                  <div className="mt-1 text-xs text-red-300">Unauthorized trustline</div>
                ) : null}
                {holding.stellarRisk?.clawbackEnabled ? (
                  <div className="mt-1 text-xs text-amber-200">Clawback enabled</div>
                ) : null}
                {holding.stellarRisk?.dataStatus === "partial" ? (
                  <div className="mt-1 text-xs text-amber-200">Issuer risk data partial</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
