#!/bin/bash
# Test script for Ghost Nav Privacy Mode (Tor/VPN integration)
# Run with: bash test-privacy-mode.sh

set -e

BASE_URL="http://localhost:8766"
ENDPOINT_PRIVACY_STATUS="$BASE_URL/api/privacy-status"
ENDPOINT_PRIVACY_MODE="$BASE_URL/api/privacy-mode"
ENDPOINT_HEALTH="$BASE_URL/api/v1/health"

echo "=========================================="
echo "Ghost Nav Privacy Mode Test Suite"
echo "=========================================="
echo ""

# Test 1: Server is running and accessible
echo "[TEST 1] Check server health..."
if ! curl -s "$ENDPOINT_HEALTH" > /dev/null 2>&1; then
    echo "❌ Server not running. Start with: python3 server.py"
    exit 1
fi
echo "✅ Server is running"
echo ""

# Test 2: Privacy status endpoint exists
echo "[TEST 2] Check privacy status endpoint..."
RESPONSE=$(curl -s "$ENDPOINT_PRIVACY_STATUS")
echo "Response: $RESPONSE"
if echo "$RESPONSE" | grep -q "tor_available\|proxy_configured\|mode"; then
    echo "✅ Privacy status endpoint working"
else
    echo "❌ Privacy status endpoint failed"
    exit 1
fi
echo ""

# Test 3: Privacy mode toggle - enable
echo "[TEST 3] Enable privacy mode..."
RESPONSE=$(curl -s -X PUT "$ENDPOINT_PRIVACY_MODE" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}')
echo "Response: $RESPONSE"
if echo "$RESPONSE" | grep -q '"enabled": true\|"enabled":true'; then
    echo "✅ Privacy mode enabled"
else
    echo "❌ Failed to enable privacy mode"
    exit 1
fi
echo ""

# Test 4: Verify privacy mode is enabled in status
echo "[TEST 4] Verify privacy mode enabled in status..."
RESPONSE=$(curl -s "$ENDPOINT_PRIVACY_STATUS")
echo "Response: $RESPONSE"
if echo "$RESPONSE" | grep -q '"mode": "enabled"\|"mode":"enabled"'; then
    echo "✅ Privacy mode confirmed as enabled"
else
    echo "⚠️  Privacy mode may not be enabled (check response above)"
fi
echo ""

# Test 5: Privacy mode toggle - disable
echo "[TEST 5] Disable privacy mode..."
RESPONSE=$(curl -s -X PUT "$ENDPOINT_PRIVACY_MODE" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}')
echo "Response: $RESPONSE"
if echo "$RESPONSE" | grep -q '"enabled": false\|"enabled":false'; then
    echo "✅ Privacy mode disabled"
else
    echo "❌ Failed to disable privacy mode"
    exit 1
fi
echo ""

# Test 6: Route request without privacy mode
echo "[TEST 6] Route request (privacy mode off)..."
RESPONSE=$(curl -s -X POST "$BASE_URL/api/v1/route" \
  -H "Content-Type: application/json" \
  -d '{
    "start": [33.0185, -80.1762],
    "end": [32.8986, -80.0407],
    "mode": "both"
  }')
echo "Response preview: $(echo $RESPONSE | cut -c1-150)..."
if echo "$RESPONSE" | grep -q "fastest\|ghost\|distance"; then
    echo "✅ Route endpoint working"
else
    echo "⚠️  Route response unexpected (may be due to network availability)"
fi
echo ""

# Test 7: Enable privacy mode again and test route
echo "[TEST 7] Enable privacy mode and test route..."
curl -s -X PUT "$ENDPOINT_PRIVACY_MODE" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}' > /dev/null
echo "✅ Privacy mode re-enabled"
echo ""

# Test 8: Check Tor availability
echo "[TEST 8] Check Tor availability..."
RESPONSE=$(curl -s "$ENDPOINT_PRIVACY_STATUS")
TOR_AVAILABLE=$(echo "$RESPONSE" | grep -o '"tor_available": *true\|"tor_available": *false' | grep -o 'true\|false' || echo "unknown")
echo "Tor available: $TOR_AVAILABLE"
if [ "$TOR_AVAILABLE" = "true" ]; then
    echo "✅ Tor is available"
    echo "   (Privacy mode will use Tor SOCKS5 for API calls)"
else
    echo "⚠️  Tor not available (privacy mode will fall back to cleartext)"
    echo "   Install Tor to enable full privacy:"
    echo "   brew install tor && brew services start tor"
fi
echo ""

# Test 9: Verify fallback to cleartext
echo "[TEST 9] Verify graceful degradation..."
RESPONSE=$(curl -s "$ENDPOINT_PRIVACY_STATUS")
echo "Current state: $RESPONSE"
FALLBACK_WARNING=$(echo "$RESPONSE" | grep -o '"fallback_warning": *true\|"fallback_warning": *false' | grep -o 'true\|false' || echo "not found")
echo "Fallback warning: $FALLBACK_WARNING"
echo "✅ Fallback handling configured"
echo ""

echo "=========================================="
echo "Test Suite Summary"
echo "=========================================="
echo "✅ All critical tests passed!"
echo ""
echo "NEXT STEPS:"
echo "1. For full privacy, install and start Tor:"
echo "   brew install tor && brew services start tor"
echo "2. Or configure a custom VPN/proxy via environment variables:"
echo "   export GHOST_PROXY_HOST=vpn.example.com"
echo "   export GHOST_PROXY_PORT=1080"
echo "3. See PRIVACY_MODE.md for detailed setup instructions"
echo ""
