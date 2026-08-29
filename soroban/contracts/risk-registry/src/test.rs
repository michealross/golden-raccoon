extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, Events},
    vec, Address, BytesN, Env, IntoVal, String, Symbol,
};

fn setup() -> (Env, RiskRegistryClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(RiskRegistry, ());
    let client = RiskRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let publisher = Address::generate(&env);
    client.initialize(&admin, &vec![&env, publisher.clone()]);
    (env, client, admin, publisher)
}

fn make_asset_id(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

fn make_report_hash(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

// ─── Initialization ─────────────────────────────────────────────────

#[test]
fn initializes_with_admin_and_publishers() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(RiskRegistry, ());
    let client = RiskRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let publisher = Address::generate(&env);

    let result = client.initialize(&admin, &vec![&env, publisher.clone()]);
    assert!(result.is_ok());

    assert_eq!(client.admin().unwrap(), admin);
    assert!(client.is_publisher(&publisher));
    assert_eq!(client.contract_version().unwrap(), 1);
}

#[test]
fn rejects_double_initialization() {
    let (_env, client, _admin, _publisher) = setup();
    let other_admin = Address::generate(&_env);
    let result = client.try_initialize(&other_admin, &vec![&_env]);
    assert_eq!(result, Err(Ok(RegistryError::AlreadyInitialized)));
}

#[test]
fn uninitialized_contract_rejects_calls() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(RiskRegistry, ());
    let client = RiskRegistryClient::new(&env, &contract_id);

    let asset_id = make_asset_id(&env, 1);
    let report_hash = make_report_hash(&env, 2);
    let network = Symbol::new(&env, "testnet");

    let result = client.try_publish_risk(
        &Address::generate(&env),
        &asset_id,
        &network,
        &String::from_str(&env, "XLM"),
        &50,
        &10_000,
        &Symbol::new(&env, "watch"),
        &report_hash,
        &String::from_str(&env, "ipfs://"),
        &1_700_000_000,
    );
    assert_eq!(result, Err(Ok(RegistryError::NotInitialized)));
}

// ─── Authorization ──────────────────────────────────────────────────

#[test]
fn unauthorized_publisher_cannot_publish() {
    let (_env, client, _admin, _publisher) = setup();
    let unknown = Address::generate(&_env);
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    let result = client.try_publish_risk(
        &unknown,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &50,
        &10_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );
    assert_eq!(result, Err(Ok(RegistryError::UnauthorizedPublisher)));
}

#[test]
fn admin_can_authorize_and_revoke_publisher() {
    let (_env, client, _admin, publisher) = setup();
    assert!(client.is_publisher(&publisher));

    client.set_publisher(&publisher, &false);
    assert!(!client.is_publisher(&publisher));

    client.set_publisher(&publisher, &true);
    assert!(client.is_publisher(&publisher));
}

#[test]
fn non_admin_cannot_set_publisher() {
    let env = Env::default();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(RiskRegistry, ());
    let client = RiskRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let publisher = Address::generate(&env);
    let stranger = Address::generate(&env);

    // Only mock admin auth — stranger is NOT authorized
    env.mock_auths(vec![admin.clone().into_val(&env)]);
    client.initialize(&admin, &vec![&env, publisher.clone()]);

    // Stranger tries to set publisher without auth — should fail
    let result = client.try_set_publisher(&stranger, &Address::generate(&env), &true);
    assert!(result.is_err(), "Non-admin must not be able to set publishers");
}

#[test]
fn non_admin_cannot_set_contract_version() {
    let env = Env::default();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(RiskRegistry, ());
    let client = RiskRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let publisher = Address::generate(&env);

    // Only mock admin auth
    env.mock_auths(vec![admin.clone().into_val(&env)]);
    client.initialize(&admin, &vec![&env, publisher]);

    // Stranger tries to set contract version without auth
    let stranger = Address::generate(&env);
    // No auth mock for stranger
    let result = client.try_set_contract_version(&stranger, &2);
    assert!(result.is_err(), "Non-admin must not be able to set contract version");
}

// ─── Bounds ─────────────────────────────────────────────────────────

#[test]
fn rejects_invalid_score() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    let result = client.try_publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &101,
        &10_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );
    assert_eq!(result, Err(Ok(RegistryError::InvalidScore)));
}

#[test]
fn rejects_invalid_confidence() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    let result = client.try_publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &50,
        &10_001,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );
    assert_eq!(result, Err(Ok(RegistryError::InvalidConfidence)));
}

#[test]
fn rejects_long_asset_label() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    let long_label = String::from_str(&_env, &"A".repeat(65));
    let result = client.try_publish_risk(
        &publisher,
        &asset_id,
        &network,
        &long_label,
        &50,
        &5_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );
    assert_eq!(result, Err(Ok(RegistryError::InvalidAssetLabel)));
}

#[test]
fn rejects_long_evidence_uri() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    let long_uri = String::from_str(&_env, &"x".repeat(513));
    let result = client.try_publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &50,
        &5_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &long_uri,
        &1_700_000_000,
    );
    assert_eq!(result, Err(Ok(RegistryError::InvalidEvidenceUri)));
}

#[test]
fn rejects_future_timestamp() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    let far_future = 1_700_000_000u64 + 301; // 301s > MAX_FUTURE_SECONDS (300)
    let result = client.try_publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &50,
        &5_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &far_future,
    );
    assert_eq!(result, Err(Ok(RegistryError::FutureTimestamp)));
}

#[test]
fn rejects_stale_timestamp() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    let too_old = 1_700_000_000u64 - (31 * 24 * 60 * 60); // 31 days ago > MAX_STALE_SECONDS
    let result = client.try_publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &50,
        &5_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &too_old,
    );
    assert_eq!(result, Err(Ok(RegistryError::StaleTimestamp)));
}

// ─── Publishing & Replacements ──────────────────────────────────────

#[test]
fn authorized_publisher_can_publish_and_update() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 7);
    let report_hash = make_report_hash(&_env, 9);
    let network = Symbol::new(&_env, "testnet");

    let record = client.publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "USDC:issuer"),
        &18,
        &5_000,
        &Symbol::new(&_env, "low"),
        &report_hash,
        &String::from_str(&_env, "ipfs://report"),
        &1_700_000_000,
    );
    assert_eq!(record.score, 18);
    assert_eq!(record.confidence_bps, 5_000);
    assert_eq!(record.version, 1);
    assert_eq!(record.publisher, publisher);

    // Update with newer timestamp
    let new_hash = make_report_hash(&_env, 10);
    let updated = client.publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "USDC:issuer"),
        &15,
        &8_000,
        &Symbol::new(&_env, "low"),
        &new_hash,
        &String::from_str(&_env, "ipfs://report-v2"),
        &1_700_000_100,
    );
    assert_eq!(updated.score, 15);
    assert_eq!(updated.confidence_bps, 8_000);
    assert_eq!(updated.version, 2); // version incremented
    assert_eq!(updated.publisher, publisher);
}

#[test]
fn rejects_stale_report_update() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    client.publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &10,
        &5_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "https://example.invalid/report"),
        &1_700_000_000,
    );

    // Same timestamp - should be rejected as stale
    let result = client.try_publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &11,
        &6_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "https://example.invalid/report"),
        &1_700_000_000,
    );
    assert_eq!(result, Err(Ok(RegistryError::StaleReport)));

    // Older timestamp - should be rejected as stale
    let result = client.try_publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &11,
        &6_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "https://example.invalid/report"),
        &1_699_999_999,
    );
    assert_eq!(result, Err(Ok(RegistryError::StaleReport)));
}

#[test]
fn get_risk_returns_none_for_missing() {
    let (_env, client, _admin, _publisher) = setup();
    let asset_id = make_asset_id(&_env, 99);
    let network = Symbol::new(&_env, "testnet");

    assert!(client.get_risk(&asset_id, &network).is_none());
}

// ─── Versioning & Upgrade ───────────────────────────────────────────

#[test]
fn contract_version_is_tracked() {
    let (_env, client, _admin, _publisher) = setup();
    assert_eq!(client.contract_version().unwrap(), 1);
}

#[test]
fn admin_can_set_contract_version() {
    let (_env, client, _admin, _publisher) = setup();
    assert!(client.set_contract_version(&2).is_ok());
    assert_eq!(client.contract_version().unwrap(), 2);
}

// ─── Contract Administration ────────────────────────────────────────

#[test]
fn admin_address_is_correct() {
    let (_env, client, admin, _publisher) = setup();
    assert_eq!(client.admin().unwrap(), admin);
}

#[test]
fn admin_can_revoke_publisher() {
    let (_env, client, _admin, publisher) = setup();
    assert!(client.is_publisher(&publisher));
    client.set_publisher(&publisher, &false);
    assert!(!client.is_publisher(&publisher));
}

// ─── Events ─────────────────────────────────────────────────────────

#[test]
fn initialization_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(RiskRegistry, ());
    let client = RiskRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let publisher = Address::generate(&env);

    client.initialize(&admin, &vec![&env, publisher.clone()]);

    let events = env.events().all();
    let found = events.iter().any(|event| {
        let topics = event.topics();
        topics.len() >= 1 && topics.get(0).unwrap().symbol().contains("RegistryInitialized")
    });
    assert!(found, "RegistryInitialized event must be emitted");
}

#[test]
fn publish_emits_risk_published_event() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 42);
    let report_hash = make_report_hash(&_env, 99);
    let network = Symbol::new(&_env, "testnet");

    let _ = client.publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "USDC"),
        &25,
        &7_500,
        &Symbol::new(&_env, "low"),
        &report_hash,
        &String::from_str(&_env, "ipfs://QmX"),
        &1_700_000_000,
    );

    let events_raw = _env.events().all();
    let risk_events: Vec<_> = events_raw.iter().filter(|event| {
        let topics = event.topics();
        topics.len() >= 1 && topics.get(0).unwrap().symbol().contains("RiskPublished")
    }).collect();
    assert_eq!(risk_events.len(), 1, "Exactly one RiskPublished event");

    if let Some(event) = risk_events.get(0) {
        let topics = event.topics();
        assert_eq!(topics.len(), 4, "RiskPublished should have 4 topics (event sig, asset_id, network, publisher)");
    }
}

#[test]
fn publisher_change_emits_event() {
    let (_env, client, _admin, publisher) = setup();
    client.set_publisher(&publisher, &false);

    let events_raw = _env.events().all();
    let found = events_raw.iter().any(|event| {
        let topics = event.topics();
        topics.len() >= 1 && topics.get(0).unwrap().symbol().contains("PublisherAuthorizationChanged")
    });
    assert!(found, "PublisherAuthorizationChanged event must be emitted");
}

// ─── TTL ────────────────────────────────────────────────────────────

#[test]
fn publish_refreshes_record_ttl() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 7);
    let report_hash = make_report_hash(&_env, 9);
    let network = Symbol::new(&_env, "testnet");

    // Publish creates a record with TTL
    client.publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &50,
        &5_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );

    // Reading it refreshes TTL
    let read = client.get_risk(&asset_id, &network);
    assert!(read.is_some());
    assert_eq!(read.unwrap().score, 50);
}

#[test]
fn extend_record_ttl_works() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    client.publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &50,
        &5_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );

    // Extend TTL explicitly
    let result = client.try_extend_record_ttl(&asset_id, &network);
    assert!(result.is_ok());
}

#[test]
fn extend_record_ttl_fails_for_nonexistent() {
    let (_env, client, _admin, _publisher) = setup();
    let asset_id = make_asset_id(&_env, 99);
    let network = Symbol::new(&_env, "testnet");

    let result = client.try_extend_record_ttl(&asset_id, &network);
    assert_eq!(result, Err(Ok(RegistryError::NotInitialized)));
}

// ─── Replayed Publications ──────────────────────────────────────────

#[test]
fn replay_with_same_timestamp_is_rejected() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);
    let network = Symbol::new(&_env, "testnet");

    // First publication succeeds
    let first = client.publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &50,
        &5_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );
    assert_eq!(first.version, 1);

    // Exact same timestamp → stale (equal timestamps are not >)
    let result = client.try_publish_risk(
        &publisher,
        &asset_id,
        &network,
        &String::from_str(&_env, "XLM"),
        &60,
        &6_000,
        &Symbol::new(&_env, "high"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );
    assert_eq!(result, Err(Ok(RegistryError::StaleReport)));
}

// ─── Multiple Networks ──────────────────────────────────────────────

#[test]
fn same_asset_different_networks_are_independent() {
    let (_env, client, _admin, publisher) = setup();
    let asset_id = make_asset_id(&_env, 1);
    let report_hash = make_report_hash(&_env, 2);

    let mainnet = Symbol::new(&_env, "pubnet");
    let testnet = Symbol::new(&_env, "testnet");

    client.publish_risk(
        &publisher,
        &asset_id,
        &mainnet,
        &String::from_str(&_env, "XLM"),
        &50,
        &5_000,
        &Symbol::new(&_env, "watch"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );

    let record_testnet = client.publish_risk(
        &publisher,
        &asset_id,
        &testnet,
        &String::from_str(&_env, "XLM"),
        &30,
        &3_000,
        &Symbol::new(&_env, "low"),
        &report_hash,
        &String::from_str(&_env, "ipfs://"),
        &1_700_000_000,
    );
    assert_eq!(record_testnet.score, 30);
    assert_eq!(record_testnet.version, 1);
}

// ─── Multiple Publishers ────────────────────────────────────────────

#[test]
fn multiple_publishers_can_publish_independently() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    let contract_id = env.register(RiskRegistry, ());
    let client = RiskRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let publisher_a = Address::generate(&env);
    let publisher_b = Address::generate(&env);

    client.initialize(&admin, &vec![&env, publisher_a.clone(), publisher_b.clone()]);

    let asset_id = make_asset_id(&env, 1);
    let report_hash = make_report_hash(&env, 2);
    let network = Symbol::new(&env, "testnet");

    let record_a = client.publish_risk(
        &publisher_a,
        &asset_id,
        &network,
        &String::from_str(&env, "XLM"),
        &50,
        &5_000,
        &Symbol::new(&env, "watch"),
        &report_hash,
        &String::from_str(&env, "ipfs://a"),
        &1_700_000_000,
    );
    assert_eq!(record_a.publisher, publisher_a);
    assert_eq!(record_a.version, 1);

    // Publisher B updates with newer timestamp
    let record_b = client.publish_risk(
        &publisher_b,
        &asset_id,
        &network,
        &String::from_str(&env, "XLM-updated"),
        &30,
        &8_000,
        &Symbol::new(&env, "low"),
        &report_hash,
        &String::from_str(&env, "ipfs://b"),
        &1_700_000_100,
    );
    assert_eq!(record_b.publisher, publisher_b);
    assert_eq!(record_b.version, 2); // version 2 because A published first
}
