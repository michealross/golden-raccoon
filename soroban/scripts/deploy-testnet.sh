#!/usr/bin/env bash
# Deploy Risk Registry to Stellar Testnet
# Usage: ./scripts/deploy-testnet.sh [--no-wasm]
set -euo pipefail

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══ Risk Registry Deployment ═══${NC}"
echo "Network:  $NETWORK"
echo "RPC URL:  $RPC_URL"
echo ""

# Build optimized WASM
if [ "${1:-}" != "--no-wasm" ]; then
  echo -e "${BLUE}Installing WASM target for reproducible build...${NC}"
  rustup target add wasm32-unknown-unknown 2>&1
  echo -e "${BLUE}Building optimized WASM (locked)${NC}"
  cargo build --locked --release --target wasm32-unknown-unknown --package golden-raccoon-risk-registry 2>&1
  WASM_PATH="target/wasm32-unknown-unknown/release/golden_raccoon_risk_registry.wasm"
  echo -e "${GREEN}WASM built: $WASM_PATH${NC}"
  echo "WASM size: $(wc -c < "$WASM_PATH") bytes"
  echo "SHA256:    $(sha256sum "$WASM_PATH" | cut -d' ' -f1)"
  echo ""
fi

# Install soroban-cli if not present
if ! command -v soroban &> /dev/null; then
  echo "Installing soroban-cli..."
  cargo install soroban-cli --locked 2>&1 | tail -3
fi

# Check if identity exists
IDENTITY="risk-registry-admin"
if ! soroban config identity ls 2>&1 | grep -q "$IDENTITY"; then
  echo "Creating identity: $IDENTITY"
  soroban config identity generate "$IDENTITY"
fi
ADMIN_ADDRESS=$(soroban config identity address "$IDENTITY")
echo "Admin address: $ADMIN_ADDRESS"
echo ""

# Deploy contract
WASM_PATH="target/wasm32-unknown-unknown/release/golden_raccoon_risk_registry.wasm"
echo -e "${BLUE}Deploying contract...${NC}"
CONTRACT_ID=$(soroban contract deploy \
  --network "$NETWORK" \
  --source "$IDENTITY" \
  --wasm "$WASM_PATH")
echo -e "${GREEN}Contract ID: $CONTRACT_ID${NC}"
echo ""

# Initialize contract with admin as initial publisher
INITIAL_PUBLISHERS="$ADMIN_ADDRESS"
echo -e "${BLUE}Initializing contract...${NC}"
soroban contract invoke \
  --network "$NETWORK" \
  --source "$IDENTITY" \
  --id "$CONTRACT_ID" \
  -- \
  initialize \
  --admin "$ADMIN_ADDRESS" \
  --publishers "[$INITIAL_PUBLISHERS]"
echo -e "${GREEN}Contract initialized${NC}"
echo ""

# Output summary
echo -e "${BLUE}═══ Deployment Summary ═══${NC}"
echo "Network:        $NETWORK"
echo "Admin:          $ADMIN_ADDRESS"
echo "Contract ID:    $CONTRACT_ID"
echo "RPC URL:        $RPC_URL"
echo ""
echo "Verification:"
echo "  soroban contract read --network $NETWORK --id $CONTRACT_ID --key admin"
echo "  soroban contract invoke --network $NETWORK --id $CONTRACT_ID -- is_publisher --publisher $ADMIN_ADDRESS"
echo ""
echo "Bindings:"
echo "  soroban contract bindings ts --network $NETWORK --id $CONTRACT_ID --output-dir bindings/risk-registry"
echo ""
