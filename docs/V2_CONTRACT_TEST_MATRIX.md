# V2 Contract Test Matrix

| Field | Value |
| --- | --- |
| Issue | Drago-Labs/golden-raccoon#16 |
| Companion spec | `docs/V2_CONTRACT_SPEC.md` |
| Status | Implementation-ready. Defaults in `docs/V2_CONTRACT_SPEC.md` §9.5 are binding unless a reviewer comment substitutes a specific item; absent substitutions, defaults merge at PR approval. |
| Scope | Implementation-ready test cases for both `GoldRaccoonVault` (EVM) and `RiskRegistry` (Soroban) |

The matrix is exhaustive enough to implement without product guesses. Each row carries a stable identifier (`T-EVM-xxx`, `T-SOR-xxx`) so it can be cross-referenced from the implementation PRs and the audit checklist.

Conventions:

- ✅ = pass / expected behavior
- ❌ = revert / expected error
- `events[N]` = the Nth event expected in the order listed
- `state` = expected post-state of the contract storage
- Both chains follow the same human-readable semantic events; the implementation per chain is described in the test row.

Pre-conditions common to all tests:

- `GoldRaccoonVault` is deployed on a target EVM testnet with `owner = deployer`, `agent = address(0)`, `paused = false`, `agents = {}`, `policyHash = bytes32(0)`, `usedIntents = {}`.
- `RiskRegistry` is deployed on Stellar Testnet with `admin = deployer`, `publishers = {}`, `paused = false`, `version = (0,1,0, ZERO)`.
- Block timestamps and ledger timestamps are deterministic per test harness.

---

## EVM — `GoldRaccoonVault`

### Authorization and lifecycle

| ID | Test case | Precondition | Action | Expected events | Expected state | Expected error |
| --- | --- | --- | --- | --- | --- | --- |
| T-EVM-001 | `version()` returns registered triple | contract deployed | `version()` | `VersionReported` (on first call) | `version = (0,1,0, buildHash)` then unchanged | none |
| T-EVM-002 | `addAgent` happy path | owner is `deployer` | `addAgent(agentA, expiry = block.timestamp + 30 days)` | `AgentApproved(wallet, agentA, approvedAt, policyHash)` | `agentExpiries[agentA] = expiry`, `policyHash[w] = bytes32(0)` | none |
| T-EVM-003 | `addAgent` zero agent | owner | `addAgent(address(0), expiry)` | — | unchanged | `ZeroAddress` |
| T-EVM-004 | `addAgent` zero expiry | owner | `addAgent(agentA, 0)` | — | unchanged | `InvalidFormat("expiry required")` |
| T-EVM-005 | `addAgent` non-owner | sender ≠ owner | `addAgent(agentA, expiry)` | — | unchanged | `NotOwner` |
| T-EVM-006 | `removeAgent` happy path | agent added | `removeAgent(agentA, "rotated")` | `AgentRevoked(wallet, agentA, revokedAt, "rotated")` | `agentExpiries[agentA] = 0` | none |
| T-EVM-007 | `removeAgent` unknown agent | owner | `removeAgent(agentUnknown, "x")` | — | unchanged | `InvalidFormat("unknown agent")` |
| T-EVM-008 | `rotateAgent` happy path | agentA added | `rotateAgent(agentA, agentB, newExpiry)` | `AgentRevoked(wallet, agentA, …)`, `AgentApproved(wallet, agentB, …, newPolicyHash)`, `AgentRotated(wallet, agentA, agentB, …, newPolicyHash)` | `agentExpiries[agentB] = newExpiry`, `agentExpiries[agentA] = 0` | none |
| T-EVM-009 | `rotateAgent` previous agent unknown | owner | `rotateAgent(address(0), agentB, newExpiry)` | — | unchanged | `InvalidFormat("agent not registered")` |
| T-EVM-010 | `rotateAgent` while paused | paused | `rotateAgent(agentA, agentB, newExpiry)` | — | unchanged | `Paused` |
| T-EVM-011 | `setPolicy` happy path | owner | `setPolicy(policyBytes)` | `PolicyUpdated(wallet, policyHash, updatedAt)` | `policyHash[w] = newPolicyHash` | none |
| T-EVM-012 | `setPolicy` malformed bytes | owner | `setPolicy(0x00)` | — | unchanged | `InvalidFormat("policy length")` |
| T-EVM-013 | `getPolicyHash` returns current | policy set | `getPolicyHash(wallet)` | — | `policyHash` matches last set | none |
| T-EVM-014 | `logDecision` happy path | agent added, policy set | `logDecision(decisionHash, policyHash, riskScore, "plan_id_uuid")` | `DecisionLogged(wallet, agent, decisionHash, decisionId, policyHash, "plan_id_uuid", riskScore, createdAt)` where `decisionId = keccak256(abi.encode(uint256(block.chainid), msg.sender, decisionCounter))` and the emitted value is the bytes32 form (not a string) | `decisionCounter[msg.sender] += 1`; off-chain state derives `decision_id` via §8. | none |
| T-EVM-014-NI | `logDecision` non-canonical planId | agent added, policy set | `logDecision(decisionHash, policyHash, riskScore, "")` | — | unchanged | `InvalidFormat("plan_id required")` |
| T-EVM-014-NI-2 | `logDecision` oversized planId | agent added, policy set | `logDecision(decisionHash, policyHash, riskScore, "<161-char utf8>")` | — | unchanged | `InvalidFormat("plan_id too long")` |
| T-EVM-015 | `logDecision` non-agent | sender ≠ agent | `logDecision(...)` | — | unchanged | `NotAgent` |
| T-EVM-016 | `logDecision` expired agent | agent expiry < now | `logDecision(...)` | — | unchanged | `Expired` |
| T-EVM-017 | `logDecision` zero hash | agent | `logDecision(bytes32(0), …)` | — | unchanged | `ZeroHash` |
| T-EVM-018 | `logDecision` invalid risk score | agent | `logDecision(..., riskScore=200)` | — | unchanged | `InvalidRiskScore(200)` |
| T-EVM-019 | `logDecision` while paused | paused | `logDecision(...)` | — | unchanged | `Paused` |
| T-EVM-020 | `logExecutionIntent` happy path | intent hash derived | `logExecutionIntent(intentHash, decisionHash, expiry)` | `ExecutionIntentLogged(wallet, intentHash, decisionHash, expiry, nonce)` | `usedIntents[intentHash] = true`, `nonces[w] += 1` | none |
| T-EVM-021 | `logExecutionIntent` replay | already recorded | `logExecutionIntent(sameIntentHash, …)` | **—** (no event emitted on revert) | unchanged | `Replay` |
| T-EVM-022 | `logExecutionIntent` stale | expiry <= now | `logExecutionIntent(intentHash, decisionHash, expiry, "plan_id_uuid")` | **—** (no event emitted on revert) | unchanged | `StaleIntent` |
| T-EVM-021a | `surfaceReplay` happy path | a `logExecutionIntent` previously reverted with `Replay` | `surfaceReplay(intentHash)` (onlyOwner) | `ExecutionIntentReplayed(intentHash, msg.sender, uint64(block.timestamp))` | unchanged | none |
| T-EVM-021a-NI | `surfaceReplay` non-owner | third party | `surfaceReplay(intentHash)` | — | unchanged | `NotOwner` |
| T-EVM-022a | `surfaceStale` happy path | a `logExecutionIntent` previously reverted with `StaleIntent` | `surfaceStale(intentHash, expiry, observedTs)` (onlyOwner) | `ExecutionIntentExpired(msg.sender, intentHash, expiry, observedTs)` | unchanged | none |
| T-EVM-022a-NI | `surfaceStale` non-owner | third party | `surfaceStale(intentHash, expiry, observedTs)` | — | unchanged | `NotOwner` |
| T-EVM-023 | `logExecutionIntent` zero hash | owner | `logExecutionIntent(bytes32(0), …)` | — | unchanged | `ZeroHash` |
| T-EVM-024 | `logExecutionIntent` non-owner | agent | `logExecutionIntent(...)` | — | unchanged | `NotOwner` (only owner logs intents) |
| T-EVM-025 | `logExecutionIntent` while paused | paused | `logExecutionIntent(...)` | — | unchanged | `Paused` |
| T-EVM-026 | `pause` by owner | owner | `pause("security review")` | `EmergencyPauseSet(wallet, true, pausedAt, "security review")` | `paused = true` | none |
| T-EVM-027 | `pause` by guardian | guardian set | `pause("incident")` | `EmergencyPauseSet(wallet, true, pausedAt, "incident")` | `paused = true` | none |
| T-EVM-028 | `pause` empty reason by guardian | guardian | `pause("")` | `EmergencyPauseSet(wallet, true, …, "")` | `paused = true` | none |
| T-EVM-029 | `pause` empty reason by owner | owner | `pause("")` | — | unchanged | `InvalidFormat("reason required")` |
| T-EVM-030 | `pause` by non-owner non-guardian | third party | `pause("x")` | — | unchanged | `NotGuardian` |
| T-EVM-031 | `pause` while paused | owner | `pause("again")` | `EmergencyPauseSet(wallet, true, …, "again")` | `paused = true` (no-op) | none |
| T-EVM-032 | `unpause` by owner | paused | `unpause()` | `EmergencyPauseSet(wallet, false, pausedAt, "")` | `paused = false` | none |
| T-EVM-033 | `unpause` by guardian | paused | `unpause()` | — | unchanged | `NotOwner` |
| T-EVM-034 | `pause` blocks writes | paused | `addAgent`, `setPolicy`, `logDecision`, `logExecutionIntent` | — | unchanged | `Paused` |
| T-EVM-035 | `pause` does not block reads | paused | `version()`, `getPolicyHash`, `is_paused()` | — | n/a | none |
| T-EVM-036 | `transferOwnership` step 1 | owner | `transferOwnership(newOwner)` | `OwnershipTransferStarted(wallet, newOwner)` | `pendingOwner = newOwner` | none |
| T-EVM-037 | `acceptOwnership` happy path | pendingOwner set | `acceptOwnership()` | `OwnershipTransferred(wallet, pendingOwner)` | `owner = newOwner`, `pendingOwner = address(0)` | none |
| T-EVM-038 | `acceptOwnership` non-pending | third party | `acceptOwnership()` | — | unchanged | `NotPendingOwner` |
| T-EVM-039 | `transferOwnership` zero new owner | owner | `transferOwnership(address(0))` | — | unchanged | `ZeroAddress` |
| T-EVM-040 | `scheduleUpgrade` happy path | owner | `scheduleUpgrade(newImpl, delaySec = 24 * 3600)` | `UpgradeScheduled(contract, newImpl, effectiveAt, delaySec)` | `upgradePending = newImpl, effectiveAt = now + 24h`, `version` unchanged | none |
| T-EVM-041 | `scheduleUpgrade` delay too small | owner | `scheduleUpgrade(newImpl, 60)` | — | unchanged | `InvalidUpgradeDelay` |
| T-EVM-042 | `scheduleUpgrade` delay too large | owner | `scheduleUpgrade(newImpl, 31 * 86400)` | — | unchanged | `InvalidUpgradeDelay` |
| T-EVM-043 | `scheduleUpgrade` while pending | one pending | `scheduleUpgrade(newImpl2, 24 * 3600)` | — | unchanged | `UpgradeNotPending` |
| T-EVM-044 | `executeUpgrade` before effective | pending | `executeUpgrade()` | — | unchanged | `UpgradeNotReady` |
| T-EVM-045 | `executeUpgrade` after effective | pending, effectiveAt reached | `executeUpgrade()` | `UpgradeExecuted(contract, newImpl, executedAt)` | `upgradePending` cleared; implementation swapped | none |
| T-EVM-046 | `cancelUpgrade` before execute | pending | `cancelUpgrade()` | `UpgradeCancelled(contract, newImpl, cancelledAt)` | `upgradePending` cleared | none |
| T-EVM-047 | `upgrade` after `executeUpgrade` re-emits version | new implementation | `version()` on new impl | `VersionReported(contract, semver, buildHash, reportedAt)` | `version` reflects new impl | none |

### Non-custodial guard

| ID | Test case | Precondition | Action | Expected behavior |
| --- | --- | --- | --- | --- |
| T-EVM-048 | No ERC-20 / swap / transfer / approve methods | contract ABI | reflection | ABI surface contains only `setAgent/setRules/logDecision/revokeAgent/(+V2 addAgent/removeAgent/rotateAgent/setPolicy/logDecision/logExecutionIntent/pause/unpause/transferOwnership/acceptOwnership/scheduleUpgrade/executeUpgrade/cancelUpgrade/version)` |
| T-EVM-049 | No `private` storage holds a key | contract ABI | reflection | no `mapping(address=>bytes32) private _keys` or similar |
| T-EVM-050 | Pause does not move funds | paused | arbitrary admin call | no `Transfer` event ever emitted; events limited to vault-managed events |

---

## Soroban — `RiskRegistry`

### Initialization and authorization

| ID | Test case | Precondition | Action | Expected events | Expected state | Expected error |
| --- | --- | --- | --- | --- | --- | --- |
| T-SOR-001 | `initialize` happy path | not initialized | `initialize(admin, publishers, tiers, expiries, version)` | `RegistryInitialized(admin)`, `VersionReported(...)` | `Admin = admin`, `Publishers = {…}`, `Version = version`, `Paused = false` | none |
| T-SOR-002 | `initialize` second call | initialized | `initialize(...)` | — | unchanged | `AlreadyInitialized` |
| T-SOR-003 | `initialize` zero admin | not initialized | `initialize(Address::zero(), …)` | — | unchanged | `ZeroAddress` |
| T-SOR-004 | `initialize` zero publisher | not initialized | `initialize(admin, [zero], …)` | — | unchanged | `ZeroAddress` |
| T-SOR-005 | `initialize` invalid tier | not initialized | `initialize(admin, …, tiers = ["x".repeat(33)], …)` | — | unchanged | `InvalidTier` |
| T-SOR-006 | `initialize` invalid expiry | not initialized | `initialize(admin, …, expiries = [0])` | — | unchanged | `InvalidFormat("publisher expiry required")` |
| T-SOR-007 | `initialize` zero upgrade build | not initialized | `initialize(admin, …, version = (0,1,0, BytesN::from_array([0;32])))` | — | unchanged | `ZeroHash` |
| T-SOR-008 | `set_publisher` happy path | initialized | `set_publisher(p, true, "gold_raccoon", expiry)` | `PublisherAuthorizationChanged(p, true, "gold_raccoon", changedAt)` | `Publisher(p) = true`, `Tier(p) = "gold_raccoon"`, `Expiry(p) = expiry` | none |
| T-SOR-009 | `set_publisher` revoke | publisher added | `set_publisher(p, false, "gold_raccoon", 0)` | `PublisherAuthorizationChanged(p, false, "gold_raccoon", ts)` | `Publisher(p)` removed | none |
| T-SOR-010 | `set_publisher` non-admin | non-admin signer | `set_publisher(p, true, "tier", expiry)` | — | unchanged | `(no auth)` — `require_auth` reverts |
| T-SOR-011 | `set_publisher` zero publisher | admin | `set_publisher(Address::zero(), true, "tier", expiry)` | — | unchanged | `ZeroAddress` |
| T-SOR-012 | `set_publisher` invalid tier | admin | `set_publisher(p, true, "x".repeat(33), expiry)` | — | unchanged | `InvalidTier` |
| T-SOR-013 | `set_publisher` while paused | paused | `set_publisher(p, true, "tier", expiry)` | — | unchanged | `Paused` |

### Publishing and revoking

| ID | Test case | Precondition | Action | Expected events | Expected state | Expected error |
| --- | --- | --- | --- | --- | --- | --- |
| T-SOR-014 | `publish_risk` happy path | authorized publisher | `publish_risk(p, asset, "GOAT", "GOAT", 42, "watch", reportHash, "https://…", updatedAt)` | `RiskPublished(asset, "GOAT", p, 42, "watch", reportHash, updatedAt)` | `Record(asset, "GOAT") = new record` | none |
| T-SOR-015 | `publish_risk` non-publisher | unknown signer | `publish_risk(...)` | — | unchanged | `UnauthorizedPublisher` |
| T-SOR-016 | `publish_risk` expired publisher | publisher expiry < now | `publish_risk(...)` | — | unchanged | `Expired` |
| T-SOR-017 | `publish_risk` score > 100 | publisher | `publish_risk(..., score=200, ...)` | — | unchanged | `InvalidScore` |
| T-SOR-018 | `publish_risk` future timestamp | publisher | `publish_risk(..., updatedAt = now + 600, ...)` | — | unchanged | `FutureTimestamp` |
| T-SOR-019 | `publish_risk` stale | existing record newer | `publish_risk(..., updatedAt = existing.updated_at, ...)` | — | unchanged | `StaleReport` |
| T-SOR-020 | `publish_risk` zero asset id | publisher | `publish_risk(..., assetId = zero, ...)` | — | unchanged | `ZeroHash` |
| T-SOR-021 | `publish_risk` zero report hash | publisher | `publish_risk(..., reportHash = zero, ...)` | — | unchanged | `ZeroHash` |
| T-SOR-022 | `publish_risk` paused | paused | `publish_risk(...)` | — | unchanged | `Paused` |
| T-SOR-023 | `publish_risk` replay same nonce | publisher, nonce=1 already used | `publish_risk(..., reportHash = hash(nonce=1, ...))` | — | unchanged | `ReplayProtection` |
| T-SOR-024 | `revoke_risk` happy path | record exists | `revoke_risk(asset, "GOAT", "incorrect")` | `RiskRevoked(asset, "GOAT", revokedAt, "incorrect", admin)` | `record.revoked = true`, `record.revocation_reason = "incorrect"`, `record.revocation_admin = admin` | none |
| T-SOR-025 | `revoke_risk` non-admin | non-admin signer | `revoke_risk(...)` | — | unchanged | `(no auth)` |
| T-SOR-026 | `revoke_risk` zero asset | admin | `revoke_risk(zero, "GOAT", "x")` | — | unchanged | `ZeroHash` |
| T-SOR-027 | `revoke_risk` unknown record | admin | `revoke_risk(arbitraryAsset, "GOAT", "x")` | — | unchanged | `InvalidFormat("record not found")` |
| T-SOR-028 | `revoke_risk` already revoked | record already revoked | `revoke_risk(asset, "GOAT", "x")` | — | unchanged | `StaleReport` |
| T-SOR-029 | `revoke_risk` while paused | paused | `revoke_risk(...)` | — | unchanged | `Paused` |
| T-SOR-030 | `get_risk` returns current record | record exists | `get_risk(asset, "GOAT")` | — | record returned | none |
| T-SOR-031 | `get_risk` unknown record | record absent | `get_risk(asset, "GOAT")` | — | `None` | none |
| T-SOR-032 | `get_risk` bumps TTL | record exists | `get_risk(asset, "GOAT")` | — | `Record` TTL extended | none |
| T-SOR-033 | `is_publisher` true | publisher added | `is_publisher(p)` | — | `true` | none |
| T-SOR-034 | `is_publisher` false | publisher revoked | `is_publisher(p)` | — | `false` | none |
| T-SOR-035 | `is_publisher` expired | publisher expiry < now | `is_publisher(p)` | — | `false` (TTL expired) | none |

### Pause, version, admin transfer

| ID | Test case | Precondition | Action | Expected events | Expected state | Expected error |
| --- | --- | --- | --- | --- | --- | --- |
| T-SOR-036 | `pause` by admin | initialized | `pause("incident")` | `RegistryEmergencyPauseSet(true, pausedAt, "incident")` | `Paused = true`, `PauseReason = "incident"` | none |
| T-SOR-037 | `pause` by guardian | guardian set | `pause("")` | `RegistryEmergencyPauseSet(true, ts, "")` | `Paused = true` | none |
| T-SOR-038 | `pause` empty reason by admin | admin | `pause("")` | — | unchanged | `InvalidFormat("reason required")` |
| T-SOR-039 | `pause` while paused | paused | `pause("x")` | `RegistryEmergencyPauseSet(true, ts, "x")` | `Paused = true` (no-op) | none |
| T-SOR-040 | `unpause` by admin | paused | `unpause()` | `RegistryEmergencyPauseSet(false, ts, "")` | `Paused = false` | none |
| T-SOR-041 | `unpause` by guardian | paused | `unpause()` | — | unchanged | `NotOwner` |
| T-SOR-042 | `pause` blocks writes | paused | `publish_risk`, `revoke_risk`, `set_publisher` | — | unchanged | `Paused` |
| T-SOR-043 | `pause` does not block reads | paused | `get_risk`, `version`, `is_paused` | — | n/a | none |
| T-SOR-044 | `version` returns current | initialized | `version()` | — | `version` tuple | none |
| T-SOR-045 | `version` emits event | first call | `version()` | `VersionReported(...)` | `version` unchanged | none |
| T-SOR-046 | `transfer_admin` step 1 | initialized | `transfer_admin(newAdmin)` | `AdminTransferStarted(admin, newAdmin)` | `PendingAdmin = newAdmin` | none |
| T-SOR-047 | `accept_admin` happy path | pending set | `accept_admin()` | `AdminTransferred(admin, newAdmin)` | `Admin = newAdmin`, `PendingAdmin = none` | none |
| T-SOR-048 | `accept_admin` non-pending | third party | `accept_admin()` | — | unchanged | `NotPendingAdmin` |
| T-SOR-049 | `transfer_admin` zero | admin | `transfer_admin(Address::zero())` | — | unchanged | `ZeroAddress` |
| T-SOR-050 | `transfer_admin` while pending | pending | `transfer_admin(other)` | — | unchanged | `AdminAlreadyPending` |
| T-SOR-051 | `admin` returns current | initialized | `admin()` | — | `Some(admin)` | none |
| T-SOR-052 | `is_paused` returns current | initial or paused | `is_paused()` | — | current value | none |

### Upgrade

| ID | Test case | Precondition | Action | Expected events | Expected state | Expected error |
| --- | --- | --- | --- | --- | --- | --- |
| T-SOR-053 | `schedule_upgrade` happy path | initialized | `schedule_upgrade(newWasm, 24 * 3600)` | `UpgradeScheduled(contract, newWasm, effectiveAt, delaySec)` | `UpgradePending = newWasm`, `EffectiveAt = now + 24h` | none |
| T-SOR-054 | `schedule_upgrade` delay too small | initialized | `schedule_upgrade(newWasm, 60)` | — | unchanged | `InvalidUpgradeDelay` |
| T-SOR-055 | `schedule_upgrade` delay too large | initialized | `schedule_upgrade(newWasm, 31 * 86400)` | — | unchanged | `InvalidUpgradeDelay` |
| T-SOR-056 | `schedule_upgrade` while pending | pending | `schedule_upgrade(newWasm2, 24 * 3600)` | — | unchanged | `UpgradeNotPending` |
| T-SOR-057 | `execute_upgrade` before effective | pending | `execute_upgrade()` | — | unchanged | `UpgradeNotReady` |
| T-SOR-058 | `execute_upgrade` after effective | pending, effectiveAt reached | `execute_upgrade()` | `UpgradeExecuted(newWasm, executedAt)` | `UpgradePending` cleared | none |
| T-SOR-059 | `cancel_upgrade` before execute | pending | `cancel_upgrade()` | `UpgradeCancelled(newWasm, cancelledAt)` | `UpgradePending` cleared | none |
| T-SOR-060 | `cancel_upgrade` no pending | none | `cancel_upgrade()` | — | unchanged | `UpgradeNotPending` |
| T-SOR-061 | `execute_upgrade` without pending | none | `execute_upgrade()` | — | unchanged | `UpgradeNotPending` |
| T-SOR-062 | `schedule_upgrade` zero wasm hash | initialized | `schedule_upgrade(BytesN::from_array([0;32]), 24 * 3600)` | — | unchanged | `ZeroHash` |
| T-SOR-063 | `schedule_upgrade` non-admin | non-admin | `schedule_upgrade(...)` | — | unchanged | `NotOwner` |

### Storage / TTL

| ID | Test case | Precondition | Action | Expected state |
| --- | --- | --- | --- | --- |
| T-SOR-064 | Persistent storage TTL bump on `publish_risk` | record exists | `publish_risk(...)` | `Record` TTL extended |
| T-SOR-065 | Persistent storage TTL bump on `get_risk` | record exists | `get_risk(...)` | `Record` TTL extended |
| T-SOR-066 | Instance TTL bump on admin write | any admin write | `set_publisher(...)` | instance TTL extended |
| T-SOR-067 | Publisher TTL bump on `publish_risk` | publisher exists | `publish_risk(...)` | `Publisher` and `Tier` TTLs extended |
| T-SOR-068 | Publisher TTL bump on `set_publisher` | publisher added | `set_publisher(...)` | publisher TTL extended |
| T-SOR-069 | Upgrade pending TTL | upgrade scheduled | `get_risk(...)` (no TTL bump on upgrade pending) | `UpgradePending` TTL = `UPGRADE_TTL_THRESHOLD`/`UPGRADE_TTL_EXTEND_TO` constants |

### Non-custodial guard

| ID | Test case | Precondition | Action | Expected behavior |
| --- | --- | --- | --- | --- |
| T-SOR-070 | No token transfer / swap / approve methods | contract ABI | reflection | only operations in `RiskRegistry` are present; no token contract is referenced |
| T-SOR-071 | No `private` storage holds a key | contract ABI | reflection | no `pub _signers: Map<>` for keys |
| T-SOR-072 | Pause does not move funds | paused | arbitrary admin call | no `transfer` / `move` / `approve` events ever emitted |

---

## Cross-chain parity tests

These tests assert that the same semantic event name, field order, and indexer mapping apply to both chains. They are run with dual indexers in the test harness.

| ID | Test case | Expected behavior |
| --- | --- | --- |
| T-X-001 | `VersionReported` event ordering | EVM `VersionReported` and Soroban `VersionReported` follow the same identifier format (semver + 32-byte build hash) |
| T-X-002 | `PolicyUpdated` / `DecisionLogged` parity | EVM emits `PolicyUpdated`/`DecisionLogged`; Soroban reference (out of scope) emits `PolicyUpdated` mirror events |
| T-X-003 | `EmergencyPauseSet` parity | both chains emit `EmergencyPauseSet` with `paused` boolean and `reason` |
| T-X-004 | `UpgradeScheduled` / `UpgradeExecuted` parity | both chains emit matching events with `newImplementationHash` and `effectiveAt` |
| T-X-005 | `idempotencyKey` pass-through | both chains never parse the key; the frontend correlates by `tx_hash` |
| T-X-006 | `decision_id` canonicalization | EVM lower-cased hex; Soroban upper-cased hex; both 64 hex chars (32 bytes). `decision_id` is contract-computed; callers must NOT supply a value. Re-derive via §8 from `(chainId, wallet, decisionCounter)` (EVM) or `(network_short_name, publisher, counter)` (Soroban). |
| T-X-009 | `plan_id` passthrough parity | EVM emits `DecisionLogged.planId` and `ExecutionIntentLogged.planId` as the same byte-for-byte UTF-8 string the agent supplied; Soroban mirrors the byte-for-byte string. The contract NEVER reads `plan_id` and NEVER hashes it. Both chains treat `plan_id` as a transparent correlation key. |
| T-X-007 | `tx_hash` chain family collision | submitting an EVM hash against a Stellar RPC rejects with `hash_chain_family_mismatch` |
| T-X-008 | `network_chain_family_mismatch` | submitting `chainFamily: evm` with `network: stellar-testnet` rejects with `network_chain_family_mismatch` |

---

## Side-effect ordering

For every state-changing call the test must verify:

1. The state delta is applied first (state writes complete; for Soroban, instance TTL is bumped on the same atomic write).
2. Then the event is emitted. Topic ordering is per-event as documented in `docs/V2_CONTRACT_SPEC.md` §4 — there is no single global topic ordering. The relevant per-event topic orderings are:
   - `DecisionLogged`: `wallet`, `agent`, `decisionHash`. (`decision_id` is in the data field, not a topic.)
   - `ExecutionIntentLogged`: `wallet`, `intentHash`.
   - `ExecutionIntentReplayed`: `intentHash`, `wallet`.
   - `ExecutionIntentExpired`: `wallet`, `intentHash`.
   - `RiskPublished`: `asset_id`, `network`, `publisher`.
   - `RiskRevoked`: `asset_id`, `network`.
3. Then any data-field indexer fields (`nonce`, `expiry`, `decision_id`, etc.) are read in the documented `docs/V2_CONTRACT_SPEC.md` §4 column order per event.
4. Then the function returns.

Invalid orderings or missing events fail the test.

---

## Failure-mode coverage

For every revert path the test must verify:

1. No state delta is applied.
2. No event is emitted.
3. The storage TTL is unchanged.
4. The error code is correct.

These invariants are mirrored on the frontend side via the V2 transaction lifecycle (#15) and the indexer.

---

## Test harness requirements

- Both contracts must be deployed with deterministic admin keys owned by the test harness.
- Both chains must use deterministic block timestamps; tests cannot rely on `block.timestamp` or `env.ledger().timestamp()` returning real-time values.
- The frontend must:
  - Receive indexer events for both chains and index them against the same `transaction_lifecycle_events` table.
  - Reject events whose canonical identifier does not match the chain family.
  - Surface `EmergencyPauseSet` and `UpgradeExecuted` events as veto signals in the agent timeline.
- The Soroban publish_risk replay test must use a deterministic `reportHash` to ensure the nonce check is reproducible.

---

## Defaults anchored in §9.5

The defaults below mirror `docs/V2_CONTRACT_SPEC.md` §9.5 so reviewers can cross-check the matrix against the spec without running into drift. Each default is binding at PR merge unless a reviewer comment substitutes it via the §9.5 substitution path. This closes the reviewer comment that the matrix referenced "pending maintainer sign-off" wording; the matrix now references the §9.5 *defaults and reviewer substitution policy*.

Reference links:

- **EVM testnet production target** — see `docs/V2_CONTRACT_SPEC.md` §9.1 (default primary: GOAT Network id 48816; default secondary: Base Sepolia, see §9.6).
- **Publisher tier list** — see `docs/V2_CONTRACT_SPEC.md` §9.5 item 5 (default: `gold_raccoon`, `partner`, `community`).
- **Upgrade delay window** — see `docs/V2_CONTRACT_SPEC.md` §9.5 item 4 (default: 24h minimum, 30d maximum).
- **Quorum for pause / owner transfer / upgrade execution** — see `docs/V2_CONTRACT_SPEC.md` §9.5 item 7 (default: deferred; covered by V2-068+).
- **`VersionReported` schema** — see `docs/V2_CONTRACT_SPEC.md` §4 (event signature is the canonical schema; implementation MUST emit semver + `buildHash` in the documented order).
