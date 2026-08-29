#![no_std]

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env, String, Symbol, Vec};

// ─── TTL Configuration ──────────────────────────────────────────────
const INSTANCE_TTL_THRESHOLD: u32 = 30 * 24 * 60 * 60 / 5;    // 30d
const INSTANCE_TTL_EXTEND_TO: u32 = 120 * 24 * 60 * 60 / 5;   // 120d
const RECORD_TTL_THRESHOLD: u32 = 60 * 24 * 60 * 60 / 5;      // 60d
const RECORD_TTL_EXTEND_TO: u32 = 365 * 24 * 60 * 60 / 5;     // 365d
const PUBLISHER_TTL_THRESHOLD: u32 = 60 * 24 * 60 * 60 / 5;   // 60d
const PUBLISHER_TTL_EXTEND_TO: u32 = 365 * 24 * 60 * 60 / 5;  // 365d

// ─── Bounds ────────────────────────────────────────────────────────
const MAX_FUTURE_SECONDS: u64 = 300;           // 5 min into future
const MAX_STALE_SECONDS: u64 = 30 * 24 * 60 * 60; // 30 days max age
const MAX_ASSET_LABEL_BYTES: u32 = 64;
const MAX_EVIDENCE_URI_BYTES: u32 = 512;
const MAX_SCORE: u32 = 100;
const MAX_CONFIDENCE_BPS: u32 = 10_000;        // 100.00%
const CONTRACT_VERSION: u32 = 1;

// ─── Data Keys ─────────────────────────────────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Initialized,
    Version,
    Publisher(Address),
    Record(BytesN<32>, Symbol),
}

// ─── Risk Record ────────────────────────────────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskRecord {
    pub asset_id: BytesN<32>,
    pub network: Symbol,
    pub asset_label: String,
    pub score: u32,
    pub confidence_bps: u32,
    pub verdict: Symbol,
    pub report_hash: BytesN<32>,
    pub evidence_uri: String,
    pub publisher: Address,
    pub version: u32,
    pub updated_at: u64,
    pub ledger: u32,
}

// ─── Events (stable, indexed) ──────────────────────────────────────
#[contractevent]
pub struct RegistryInitialized {
    #[topic]
    pub admin: Address,
    pub version: u32,
}

#[contractevent]
pub struct PublisherAuthorizationChanged {
    #[topic]
    pub publisher: Address,
    pub authorized: bool,
}

#[contractevent]
pub struct ContractVersionChanged {
    #[topic]
    pub old_version: u32,
    #[topic]
    pub new_version: u32,
}

#[contractevent]
pub struct RiskPublished {
    #[topic]
    pub asset_id: BytesN<32>,
    #[topic]
    pub network: Symbol,
    #[topic]
    pub publisher: Address,
    pub score: u32,
    pub confidence_bps: u32,
    pub verdict: Symbol,
    pub report_hash: BytesN<32>,
    pub version: u32,
    pub updated_at: u64,
}

// ─── Errors ─────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    UnauthorizedPublisher = 3,
    InvalidScore = 4,
    FutureTimestamp = 5,
    StaleReport = 6,
    InvalidConfidence = 7,
    InvalidAssetLabel = 8,
    InvalidEvidenceUri = 9,
    StaleTimestamp = 10,
    InvalidVersion = 11,
}

// ─── Contract ───────────────────────────────────────────────────────
#[contract]
pub struct RiskRegistry;

// ─── TTL Helpers ────────────────────────────────────────────────────
fn bump_instance_ttl(env: &Env) {
    env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

fn bump_publisher_ttl(env: &Env, key: &DataKey) {
    env.storage().persistent().extend_ttl(key, PUBLISHER_TTL_THRESHOLD, PUBLISHER_TTL_EXTEND_TO);
}

fn bump_record_ttl(env: &Env, key: &DataKey) {
    env.storage().persistent().extend_ttl(key, RECORD_TTL_THRESHOLD, RECORD_TTL_EXTEND_TO);
}

fn require_initialized(env: &Env) -> Result<(), RegistryError> {
    if env.storage().instance().has(&DataKey::Initialized) {
        bump_instance_ttl(env);
        Ok(())
    } else {
        Err(RegistryError::NotInitialized)
    }
}

// ─── Bounds Validation ──────────────────────────────────────────────
fn validate_bounds(
    score: u32,
    confidence_bps: u32,
    asset_label: &String,
    evidence_uri: &String,
    updated_at: u64,
    ledger_timestamp: u64,
) -> Result<(), RegistryError> {
    if score > MAX_SCORE {
        return Err(RegistryError::InvalidScore);
    }
    if confidence_bps > MAX_CONFIDENCE_BPS {
        return Err(RegistryError::InvalidConfidence);
    }
    if asset_label.len() > MAX_ASSET_LABEL_BYTES {
        return Err(RegistryError::InvalidAssetLabel);
    }
    if evidence_uri.len() > MAX_EVIDENCE_URI_BYTES {
        return Err(RegistryError::InvalidEvidenceUri);
    }
    if updated_at > ledger_timestamp.saturating_add(MAX_FUTURE_SECONDS) {
        return Err(RegistryError::FutureTimestamp);
    }
    if updated_at < ledger_timestamp.saturating_sub(MAX_STALE_SECONDS) {
        return Err(RegistryError::StaleTimestamp);
    }
    Ok(())
}

// ─── Contract Implementation ────────────────────────────────────────
#[contractimpl]
impl RiskRegistry {
    /// Initialize the contract with an admin and initial set of publishers.
    /// Publish RegistryInitialized event with contract version.
    pub fn initialize(env: Env, admin: Address, publishers: Vec<Address>) -> Result<(), RegistryError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(RegistryError::AlreadyInitialized);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Version, &CONTRACT_VERSION);

        for publisher in publishers.iter() {
            let key = DataKey::Publisher(publisher.clone());
            env.storage().persistent().set(&key, &true);
            bump_publisher_ttl(&env, &key);
        }

        bump_instance_ttl(&env);
        RegistryInitialized { admin, version: CONTRACT_VERSION }.publish(&env);
        Ok(())
    }

    /// Authorize or revoke a publisher. Only callable by admin.
    pub fn set_publisher(env: Env, publisher: Address, authorized: bool) -> Result<(), RegistryError> {
        require_initialized(&env)?;
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        let key = DataKey::Publisher(publisher.clone());

        if authorized {
            env.storage().persistent().set(&key, &true);
            bump_publisher_ttl(&env, &key);
        } else {
            env.storage().persistent().remove(&key);
        }

        PublisherAuthorizationChanged { publisher, authorized }.publish(&env);
        Ok(())
    }

    /// Publish or update a risk record for an asset on a specific network.
    /// Enforces all bounds, validates publisher, checks staleness.
    /// Returns the newly-created RiskRecord.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_risk(
        env: Env,
        publisher: Address,
        asset_id: BytesN<32>,
        network: Symbol,
        asset_label: String,
        score: u32,
        confidence_bps: u32,
        verdict: Symbol,
        report_hash: BytesN<32>,
        evidence_uri: String,
        updated_at: u64,
    ) -> Result<RiskRecord, RegistryError> {
        require_initialized(&env)?;
        publisher.require_auth();

        // Auth check
        if !Self::is_publisher(env.clone(), publisher.clone()) {
            return Err(RegistryError::UnauthorizedPublisher);
        }

        // Bounds validation
        validate_bounds(
            score,
            confidence_bps,
            &asset_label,
            &evidence_uri,
            updated_at,
            env.ledger().timestamp(),
        )?;

        // Compute version and check staleness
        let key = DataKey::Record(asset_id.clone(), network.clone());
        let (version, ledger) = if let Some(existing) = env.storage().persistent().get::<DataKey, RiskRecord>(&key) {
            if updated_at <= existing.updated_at {
                return Err(RegistryError::StaleReport);
            }
            (existing.version.saturating_add(1), existing.ledger)
        } else {
            (1, env.ledger().sequence())
        };

        // Version increments monotonically. Saturating prevents overflow.
        let next_version = version.saturating_add(1);

        let record = RiskRecord {
            asset_id: asset_id.clone(),
            network: network.clone(),
            asset_label,
            score,
            confidence_bps,
            verdict: verdict.clone(),
            report_hash: report_hash.clone(),
            evidence_uri,
            publisher: publisher.clone(),
            version: next_version,
            updated_at,
            ledger: env.ledger().sequence(),
        };

        env.storage().persistent().set(&key, &record);
        bump_record_ttl(&env, &key);

        RiskPublished {
            asset_id,
            network,
            publisher,
            score,
            confidence_bps,
            verdict,
            report_hash,
            version: next_version,
            updated_at,
        }
        .publish(&env);

        Ok(record)
    }

    /// Read a risk record by asset_id and network.
    /// Extends TTL on hit to keep active records alive.
    pub fn get_risk(env: Env, asset_id: BytesN<32>, network: Symbol) -> Option<RiskRecord> {
        let key = DataKey::Record(asset_id, network);
        let value = env.storage().persistent().get(&key);
        if value.is_some() {
            bump_record_ttl(&env, &key);
        }
        bump_instance_ttl(&env);
        value
    }

    /// Check whether an address is an authorized publisher.
    pub fn is_publisher(env: Env, publisher: Address) -> bool {
        let key = DataKey::Publisher(publisher);
        let auth = env.storage().persistent().get(&key).unwrap_or(false);
        if auth {
            bump_publisher_ttl(&env, &key);
        }
        bump_instance_ttl(&env);
        auth
    }

    /// Return the admin address.
    pub fn admin(env: Env) -> Result<Address, RegistryError> {
        require_initialized(&env)?;
        Ok(env.storage().instance().get(&DataKey::Admin).unwrap())
    }

    /// Return the contract version.
    pub fn contract_version(env: Env) -> Result<u32, RegistryError> {
        require_initialized(&env)?;
        Ok(env.storage().instance().get(&DataKey::Version).unwrap())
    }

    /// Upgrade: set a new contract version. Only callable by admin.
    /// Requires new_version to be greater than current version.
    /// Emits ContractVersionChanged event for on-chain tracking.
    pub fn set_contract_version(env: Env, new_version: u32) -> Result<(), RegistryError> {
        require_initialized(&env)?;
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        let old_version: u32 = env.storage().instance().get(&DataKey::Version).unwrap();
        if new_version <= old_version {
            return Err(RegistryError::InvalidVersion);
        }
        env.storage().instance().set(&DataKey::Version, &new_version);
        ContractVersionChanged { old_version, new_version }.publish(&env);
        Ok(())
    }

    /// Extend TTL for a specific risk record. Useful for off-chain keepers
    /// to maintain active records.
    pub fn extend_record_ttl(env: Env, asset_id: BytesN<32>, network: Symbol) -> Result<(), RegistryError> {
        require_initialized(&env)?;
        let key = DataKey::Record(asset_id, network);
        if env.storage().persistent().has(&key) {
            bump_record_ttl(&env, &key);
            Ok(())
        } else {
            Err(RegistryError::NotInitialized)
        }
    }
}

#[cfg(test)]
mod test;
