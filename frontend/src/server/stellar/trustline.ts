import "server-only";

import { BASE_RESERVE, StrKey } from "@stellar/stellar-sdk";
import type { StellarTrustlinePreview } from "@/server/types";
import { getStellarNetwork } from "@/lib/stellar/config";
import { createStellarDataServer } from "@/server/stellar/client";
import { parseStellarAssetInput } from "@/server/stellar/assetIdentity";

const MIN_XLM_RESERVE_FOR_TRUSTLINE = 1.5; // XLM buffer above base reserve
const BASE_RESERVE_NUM = Number(BASE_RESERVE.toString()) || 0.5; // ~0.5 XLM base reserve

export type TrustlineCheckInput = {
  chain: string;
  assetCode: string;
  issuer: string;
  walletAddress: string;
};

export type TrustlineCheckResult = {
  canCreate: boolean;
  blockedReason?: StellarTrustlinePreview["blockedReason"];
  preview: StellarTrustlinePreview;
};

function computeReserveRequired(subentryCount: number): number {
  // Stellar minimum balance formula: (2 + subentry_count) * base_reserve
  // The 2 accounts for the account entry itself, each subentry (trustline, offer, etc.) adds 1
  // After adding the new trustline, the count is subentryCount + 1
  const totalEntries = 2 + Math.max(0, subentryCount + 1); // +1 for the new trustline
  return totalEntries * BASE_RESERVE_NUM;
}

export async function checkTrustlineReserve(
  walletAddress: string,
  chain: string,
): Promise<{ xlmBalance: number; subentryCount: number; reserveRequired: number; sufficient: boolean }> {
  const network = getStellarNetwork(chain);
  if (!network) {
    return { xlmBalance: 0, subentryCount: 0, reserveRequired: 0, sufficient: false };
  }

  const { server } = createStellarDataServer(chain);

  try {
    const account = await server.loadAccount(walletAddress);
    const xlmBalance = Number(account.balances.find((b) => b.asset_type === "native")?.balance ?? 0);
    const subentryCount = account.subentry_count ?? 0;
    const reserveRequired = computeReserveRequired(subentryCount);
    const sufficient = xlmBalance - reserveRequired >= MIN_XLM_RESERVE_FOR_TRUSTLINE;

    return { xlmBalance, subentryCount, reserveRequired, sufficient };
  } catch {
    // Account does not exist on Stellar network
    return { xlmBalance: 0, subentryCount: 0, reserveRequired: computeReserveRequired(0), sufficient: false };
  }
}

export async function checkExistingTrustline(
  walletAddress: string,
  assetCode: string,
  issuer: string,
  chain: string,
): Promise<boolean> {
  const network = getStellarNetwork(chain);
  if (!network) return false;

  const { server } = createStellarDataServer(chain);

  try {
    const account = await server.loadAccount(walletAddress);
    return account.balances.some(
      (b) =>
        b.asset_type !== "native" &&
        (b as { asset_code?: string; asset_issuer?: string }).asset_code?.toUpperCase() === assetCode.toUpperCase() &&
        (b as { asset_code?: string; asset_issuer?: string }).asset_issuer?.toUpperCase() === issuer.toUpperCase(),
    );
  } catch {
    return false;
  }
}

export async function checkAssetFlags(
  assetCode: string,
  issuer: string,
  chain: string,
): Promise<{
  authRequired: boolean;
  authRevocable: boolean;
  authClawbackEnabled: boolean;
  authImmutable: boolean;
  issuerExists: boolean;
}> {
  const network = getStellarNetwork(chain);
  if (!network) {
    return { authRequired: false, authRevocable: false, authClawbackEnabled: false, authImmutable: false, issuerExists: false };
  }

  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    return { authRequired: false, authRevocable: false, authClawbackEnabled: false, authImmutable: false, issuerExists: false };
  }

  const { server } = createStellarDataServer(chain);

  try {
    // Load account first to verify issuer exists
    const account = await server.loadAccount(issuer);
    const accountFlags = account.flags ?? { auth_required: false, auth_revocable: false, auth_immutable: false };

    // Fetch the specific asset record to get clawback flag (asset-level, not account-level)
    let clawbackEnabled = false;
    try {
      const assetPage = await server.assets().forCode(assetCode).forIssuer(issuer).limit(1).call();
      const assetRecord = assetPage.records[0] as Record<string, unknown> | undefined;
      if (assetRecord) {
        const assetFlags = assetRecord.flags as Record<string, unknown> | undefined;
        clawbackEnabled = assetFlags?.auth_clawback_enabled === true;
      }
    } catch {
      // Asset not found; fall back to account flags without clawback info
    }

    return {
      authRequired: accountFlags.auth_required ?? false,
      authRevocable: accountFlags.auth_revocable ?? false,
      authClawbackEnabled: clawbackEnabled,
      authImmutable: accountFlags.auth_immutable ?? false,
      issuerExists: true,
    };
  } catch {
    return { authRequired: false, authRevocable: false, authClawbackEnabled: false, authImmutable: false, issuerExists: false };
  }
}

export function validateStellarNetwork(
  chain: string,
  expectedPassphrase?: string,
): { valid: boolean; networkPassphrase: string; detail: string } {
  const network = getStellarNetwork(chain);
  if (!network) {
    return { valid: false, networkPassphrase: "", detail: `Unsupported Stellar network: ${chain}` };
  }

  return {
    valid: !expectedPassphrase || network.networkPassphrase === expectedPassphrase,
    networkPassphrase: network.networkPassphrase,
    detail: `Network ${network.id} resolved with passphrase matching.`,
  };
}

export async function validateSigningAccount(
  walletAddress: string,
  chain: string,
): Promise<{ valid: boolean; detail: string }> {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    return { valid: false, detail: `Wallet address ${walletAddress} is not a valid Stellar account.` };
  }

  const network = getStellarNetwork(chain);
  if (!network) {
    return { valid: false, detail: `Unsupported network: ${chain}` };
  }

  const { server } = createStellarDataServer(chain);

  try {
    await server.loadAccount(walletAddress);
    return { valid: true, detail: `Account ${walletAddress} exists on ${network.id}.` };
  } catch {
    return { valid: false, detail: `Account ${walletAddress} does not exist on ${network.id}. The account must be funded first.` };
  }
}

export async function buildTrustlinePreview(input: TrustlineCheckInput): Promise<TrustlineCheckResult> {
  // 1. Validate network
  const networkCheck = validateStellarNetwork(input.chain);
  if (!networkCheck.valid) {
    return {
      canCreate: false,
      blockedReason: "network_mismatch",
      preview: {
        assetCode: input.assetCode,
        issuer: input.issuer,
        isNative: false,
        reserveRequiredXlm: BASE_RESERVE_NUM,
        currentXlmBalance: 0,
        sufficientReserve: false,
        existingTrustline: false,
        blockedReason: "network_mismatch",
      },
    };
  }

  // 2. Validate the asset identity
  const identity = parseStellarAssetInput(`${input.assetCode}:${input.issuer}`, input.chain);
  if (!identity || identity.type !== "classic") {
    return {
      canCreate: false,
      blockedReason: "issuer_unknown",
      preview: {
        assetCode: input.assetCode,
        issuer: input.issuer,
        isNative: input.assetCode.toUpperCase() === "XLM",
        reserveRequiredXlm: BASE_RESERVE_NUM,
        currentXlmBalance: 0,
        sufficientReserve: false,
        existingTrustline: false,
        blockedReason: "issuer_unknown",
      },
    };
  }

  // 3. Check if trustline already exists
  const existingTrustline = await checkExistingTrustline(input.walletAddress, input.assetCode, input.issuer, input.chain);
  if (existingTrustline) {
    return {
      canCreate: false,
      blockedReason: undefined,
      preview: {
        assetCode: input.assetCode,
        issuer: input.issuer,
        contractId: identity.contractId,
        isNative: false,
        reserveRequiredXlm: 0,
        currentXlmBalance: 0,
        sufficientReserve: true,
        existingTrustline: true,
      },
    };
  }

  // 4. Check issuer flags
  const issuerFlags = await checkAssetFlags(input.assetCode, input.issuer, input.chain);
  if (!issuerFlags.issuerExists) {
    return {
      canCreate: false,
      blockedReason: "issuer_unknown",
      preview: {
        assetCode: input.assetCode,
        issuer: input.issuer,
        contractId: identity.contractId,
        isNative: false,
        reserveRequiredXlm: BASE_RESERVE_NUM,
        currentXlmBalance: 0,
        sufficientReserve: false,
        existingTrustline: false,
        blockedReason: "issuer_unknown",
      },
    };
  }

  if (issuerFlags.authClawbackEnabled) {
    return {
      canCreate: false,
      blockedReason: "clawback_enabled",
      preview: {
        assetCode: input.assetCode,
        issuer: input.issuer,
        contractId: identity.contractId,
        isNative: false,
        reserveRequiredXlm: BASE_RESERVE_NUM,
        currentXlmBalance: 0,
        sufficientReserve: false,
        issuerFlags: {
          authRequired: issuerFlags.authRequired,
          authRevocable: issuerFlags.authRevocable,
          authClawbackEnabled: issuerFlags.authClawbackEnabled,
          authImmutable: issuerFlags.authImmutable,
        },
        existingTrustline: false,
        blockedReason: "clawback_enabled",
      },
    };
  }

  if (issuerFlags.authRevocable) {
    return {
      canCreate: false,
      blockedReason: "revocable_auth",
      preview: {
        assetCode: input.assetCode,
        issuer: input.issuer,
        contractId: identity.contractId,
        isNative: false,
        reserveRequiredXlm: BASE_RESERVE_NUM,
        currentXlmBalance: 0,
        sufficientReserve: false,
        issuerFlags: {
          authRequired: issuerFlags.authRequired,
          authRevocable: issuerFlags.authRevocable,
          authClawbackEnabled: issuerFlags.authClawbackEnabled,
          authImmutable: issuerFlags.authImmutable,
        },
        existingTrustline: false,
        blockedReason: "revocable_auth",
      },
    };
  }

  // 5. Check reserve
  const reserve = await checkTrustlineReserve(input.walletAddress, input.chain);
  if (!reserve.sufficient) {
    return {
      canCreate: false,
      blockedReason: "insufficient_reserve",
      preview: {
        assetCode: input.assetCode,
        issuer: input.issuer,
        contractId: identity.contractId,
        isNative: false,
        reserveRequiredXlm: reserve.reserveRequired,
        currentXlmBalance: reserve.xlmBalance,
        sufficientReserve: false,
        issuerFlags: {
          authRequired: issuerFlags.authRequired,
          authRevocable: issuerFlags.authRevocable,
          authClawbackEnabled: issuerFlags.authClawbackEnabled,
          authImmutable: issuerFlags.authImmutable,
        },
        existingTrustline: false,
        blockedReason: "insufficient_reserve",
      },
    };
  }

  // 6. All checks pass - trustline can be created
  return {
    canCreate: true,
    preview: {
      assetCode: input.assetCode,
      issuer: input.issuer,
      contractId: identity.contractId,
      isNative: false,
      reserveRequiredXlm: reserve.reserveRequired,
      currentXlmBalance: reserve.xlmBalance,
      sufficientReserve: true,
      issuerFlags: {
        authRequired: issuerFlags.authRequired,
        authRevocable: issuerFlags.authRevocable,
        authClawbackEnabled: issuerFlags.authClawbackEnabled,
        authImmutable: issuerFlags.authImmutable,
      },
      existingTrustline: false,
    },
  };
}
