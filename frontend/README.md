This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Create `frontend/.env.local` for local secrets/config:

```bash
# Public browser config.
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_GOAT_RPC_URL=https://rpc.goat.network
NEXT_PUBLIC_GOAT_EXPLORER_URL=https://explorer.goat.network

# Server-only storage. Never expose SERVICE_ROLE keys with NEXT_PUBLIC_.
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Server-only portfolio providers.
GOLDRUSH_API_KEY=
COVALENT_API_KEY=
GOLDRUSH_CHAINS=eth-mainnet,base-mainnet,arbitrum-mainnet,bsc-mainnet,linea-mainnet,matic-mainnet,optimism-mainnet

# Optional server-only fallback: single-chain ERC-20 discovery with Alchemy.
# Supported values: ethereum, base, arbitrum.
ALCHEMY_API_KEY=
PORTFOLIO_CHAIN=

# Server-only RPC/provider config.
GOAT_RPC_URL=https://rpc.goat.network
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_DATA_API_URL=https://horizon-testnet.stellar.org
# Optional JSON array of explicitly supported SAC/SEP-41 contracts.
STELLAR_PORTFOLIO_TOKENS_JSON=
# Either provide a manually generated access token:
GOPLUS_API_KEY=
# Or provide app credentials; the server will request and cache access tokens:
GOPLUS_APP_KEY=
GOPLUS_APP_SECRET=

# Server-only x402 premium deep scan production config.
X402_PAY_TO=0x3ED3E93047b4bCF2e6Ab0744Db08a132d0c97D7d
X402_PRICE_USD=\$0.99
X402_NETWORK=eip155:8453
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
X402_ASSET=USDC
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=
```

## Stellar portfolio

The portfolio endpoint derives spendable XLM from the live base reserve,
subentries, sponsorship counts, and selling liabilities. Classic trustlines
retain issuer identity and authorization/clawback flags. XLM and official
network USDC have trusted prices; every other positive balance remains
explicitly unpriced unless it appears in the server-only
`STELLAR_PORTFOLIO_TOKENS_JSON` registry.

Configured SAC/SEP-41 entries are queried through their `balance` method and
must include `network`, `kind`, `contractId`, `symbol`, `name`, and `decimals`.
Optional trusted metadata includes `issuer`, `verified`, `priceUsd`, and
`priceSource`. Never use `0` to represent an unknown price; omit `priceUsd`.
Portfolio responses are cached for 30 seconds with a key containing both the
canonical wallet and Stellar network.

## GOAT x402 Premium Flow

The free scan remains available at `/api/scan/token`. Premium deep scan is protected at `/api/x402/deep-scan`.

- Without payment, the endpoint returns HTTP `402` with a `PAYMENT-REQUIRED` header.
- An x402-compatible buyer signs the payment and retries with `PAYMENT-SIGNATURE`.
- The server verifies through the configured x402 facilitator before running premium analysis.
- Duplicate payment signatures are blocked with a local idempotency guard.
- Production must configure `X402_PAY_TO`, `X402_PRICE_USD`, `X402_NETWORK`, and `X402_FACILITATOR_URL`.
- CDP facilitator production mode also requires `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`.

Production uses Base mainnet (`eip155:8453`) with the authenticated CDP facilitator. For local testnet checks, use Base Sepolia (`eip155:84532`) with `https://x402.org/facilitator`.

### V1 Pricing Logic

Deep Scan starts at `$0.99`.

Pricing rule:

```text
final price >= AI model cost + provider/API cost + payment/facilitator overhead + infra buffer + profit margin
```

V1 uses one fixed Deep Scan price because actual per-scan AI/provider usage is not persisted yet. After usage metering is added, keep at least a 60-70% gross margin target and adjust `X402_PRICE_USD` from production env without code changes.

Free Scan should stay free:

- Buy Risk
- Confidence
- Verdict
- Top reasons
- Basic agent cards

Paid Deep Scan should unlock:

- Full agent factor detail
- Critical blocker explanation
- Decision confidence breakdown
- What would change this decision
- Full source/missing-data details
- x402 receipt id

## Supabase Migration

The canonical V1 schema is `frontend/src/server/storage/schema.sql`.

Local or remote application steps:

1. Open the Supabase project SQL editor or connect with the Supabase CLI.
2. Run the full contents of `frontend/src/server/storage/schema.sql`.
3. Confirm these tables exist: `wallets`, `agent_runs`, `agent_results`, `recommendations`, `user_rules`, `approvals`, `transactions`, `x402_payment_receipts`, `token_identities`, `source_snapshots`.
4. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to server-only env.
5. Run `npm run deploy:check` from the repository root.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
