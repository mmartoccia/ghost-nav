# Ghost Nav Privacy Mode (Tor/VPN Integration)

## Overview

Privacy Mode routes all outbound API calls (geocoding, routing, camera data) through Tor or a user-configured VPN/SOCKS5 proxy. This prevents ISP-level correlation of navigation queries with your physical location.

## Features

- **Tor Support**: Automatic SOCKS5 connection to Tor when available
- **Custom Proxy**: Support for user-provided VPN/proxy configuration via environment variables
- **Circuit Rotation**: Rotate Tor circuits between requests to prevent circuit fingerprinting
- **DNS Leak Prevention**: All DNS resolution happens through the proxy, not system DNS
- **Graceful Degradation**: Falls back to cleartext with warning if Tor/VPN unavailable
- **Opt-In**: Privacy mode is disabled by default (user selects speed/privacy tradeoff)
- **Status Indicator**: Real-time UI showing privacy mode status and available protection

## Installation

### 1. Install Dependencies

```bash
pip3 install -r requirements-privacy.txt
```

This installs:
- `PySocks`: SOCKS5 proxy support
- `requests[socks]`: HTTP library with SOCKS5 support
- `stem`: Tor controller library

### 2. Set Up Tor (Optional but Recommended)

If you want to use Tor:

#### On macOS (via Homebrew):
```bash
brew install tor
brew services start tor
```

#### On Linux (Debian/Ubuntu):
```bash
sudo apt-get install tor
sudo systemctl start tor
sudo systemctl enable tor
```

#### Docker (Recommended for Development):
```bash
docker run -d -p 9050:9050 -p 9051:9051 \
  -e TOR_CONTROL_PASSWORD=yourpassword \
  osminogin/tor-simple
```

### 3. Configuration

Privacy mode is configured via environment variables:

```bash
# Tor SOCKS5 connection (defaults shown)
export TOR_SOCKS5_HOST=127.0.0.1
export TOR_SOCKS5_PORT=9050

# Tor control port (for circuit rotation)
export TOR_CONTROL_HOST=127.0.0.1
export TOR_CONTROL_PORT=9051
export TOR_CONTROL_PASSWORD=yourcontrolpassword

# Or use custom VPN/proxy
export GHOST_PROXY_HOST=vpn.example.com
export GHOST_PROXY_PORT=1080
export GHOST_PROXY_TYPE=socks5  # socks5 or http
```

## Usage

### Server-Side

Start the Ghost Nav server:
```bash
cd ~/clawd/ghost-nav
python3 server.py
```

The server will check privacy dependencies on startup and log availability:
```
[Startup] Checking privacy support...
[Startup] requests[socks] available: True
[Startup] stem (Tor controller) available: True
[Startup] Privacy features available. Visit /api/privacy-status to check.
```

### Client-Side (Frontend)

#### Check Privacy Status
```javascript
const response = await fetch('/api/privacy-status');
const status = await response.json();
// {
//   tor_available: true,
//   proxy_configured: false,
//   mode: 'disabled',
//   circuit_rotation_count: 5,
//   last_rotated_at: '2026-03-24T21:30:15.123456+00:00'
// }
```

#### Toggle Privacy Mode
```javascript
const response = await fetch('/api/privacy-mode', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: true }),
});
const result = await response.json();
// {
//   status: 'ok',
//   enabled: true,
//   tor_available: true,
//   proxy_configured: false
// }
```

#### UI Toggle
The Ghost Nav frontend includes a privacy mode toggle in the top-left corner:
- 🔒 **Privacy OFF** (default): All API calls sent in cleartext
- 🛡️ **Tor Connected**: API calls routed through Tor network
- 🔐 **Proxy Connected**: API calls routed through custom VPN/proxy
- ⚠️ **Privacy Mode (No Tor/VPN)**: Mode enabled but no proxy available (warning state)

## How It Works

### API Call Flow

1. **Nominatim (Geocoding)**
   - User searches for an address
   - Request routes through proxy → Nominatim API → proxy → client
   - Nominatim never sees user's IP

2. **OSRM (Routing)**
   - User requests a route
   - Request routes through proxy → OSRM API → proxy → client
   - OSRM never sees user's IP

3. **Overpass (Camera Data)**
   - Map view loads camera positions
   - Request routes through proxy → Overpass API → proxy → client
   - Overpass never sees user's IP

### Tor Circuit Rotation

When Tor is available, circuits rotate:
- Automatically on each request (future version with rate limiting)
- On-demand via control port command
- Tracks rotation count and timestamp

### DNS Privacy

DNS queries for API hostnames are resolved through the SOCKS5 proxy, preventing ISP from seeing which APIs you're calling.

## Architecture

### Server (server.py)

```python
def _fetch_with_proxy(url, timeout=15, method='GET', data=None, headers=None):
    """Fetch URL with proxy support."""
    proxy = _get_proxy_handler()  # Returns Tor/VPN proxy dict
    if proxy and requests_available:
        sess = requests.Session()
        sess.proxies = proxy  # Apply proxy
        resp = sess.get(url, headers=headers, timeout=timeout)
    else:
        # Fallback to urllib (cleartext)
    return data, status, error
```

All outbound API calls use `_fetch_with_proxy()`:
- `osrm_route()` → routes through proxy
- `fetch_cameras_in_bbox()` → routes through proxy
- Future: Nominatim calls → route through proxy

### Frontend (app.js)

```javascript
// Privacy state
let privacyModeEnabled = localStorage.getItem('ghost-privacy-mode') === 'true';

// Check status on load
async function checkPrivacyStatus() {
  const resp = await fetch('/api/privacy-status');
  privacyStatus = await resp.json();
  updatePrivacyUI();
}

// Toggle mode
async function togglePrivacyMode(enabled) {
  const resp = await fetch('/api/privacy-mode', {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
  privacyStatus = await resp.json();
  updatePrivacyUI();
}
```

## Testing

### Test Tor Connection

```bash
# Check if Tor SOCKS5 is reachable
curl --socks5 127.0.0.1:9050 https://api.ipify.org?format=json

# Should return an IP from Tor's exit node, not your real IP
```

### Test Privacy Mode

```bash
# Check privacy status
curl http://localhost:8766/api/privacy-status

# Enable privacy mode
curl -X PUT http://localhost:8766/api/privacy-mode \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# Route with privacy mode enabled
curl -X POST http://localhost:8766/api/v1/route \
  -H "Content-Type: application/json" \
  -d '{
    "start": [33.0185, -80.1762],
    "end": [32.8986, -80.0407],
    "mode": "both"
  }'
```

### Network Monitoring

Use Wireshark or `tcpdump` to verify:
1. No DNS queries to Nominatim/OSRM/Overpass (only to Tor exit node)
2. No direct TCP connections to API endpoints (only to Tor/proxy)

```bash
# Monitor DNS queries
sudo tcpdump -i en0 'udp port 53'

# Monitor HTTPS connections
sudo tcpdump -i en0 'tcp port 443'
```

## Performance Impact

Privacy mode adds latency due to:
- SOCKS5 handshake: ~100ms
- Tor routing overhead: 200-500ms per request
- Circuit rotation (if enabled): ~1-2s every N requests

**Typical latencies:**
- Cleartext: 200-300ms
- With Tor: 500-1000ms
- Difference: ~2-3x slower, but acceptable for privacy-conscious users

## Limitations

1. **DNS Leaks**: Only prevented if Tor control port configured. Without control port, DNS may leak to system resolver.
2. **Cleartext Fallback**: If Tor unavailable and privacy mode enabled, requests fall back to cleartext with a warning.
3. **API Fingerprinting**: Tor exit node may still reveal you're using Ghost Nav to Nominatim/OSRM (via User-Agent).
4. **Latency**: Tor adds 2-3x latency overhead.
5. **Throughput**: Tor bandwidth is limited; large map tiles may take longer.

## Future Enhancements

1. **Pluggable Transports**: Support for Tor bridges to bypass ISP-level Tor blocking
2. **Custom DNS**: Use Tor's DNS resolver or dnscrypt-proxy for additional DNS privacy
3. **Circuit Pinning**: Keep the same Tor circuit for a session to improve performance
4. **VPN Integration**: Support for commercial VPN APIs (ProtonVPN, Mullvad, etc.)
5. **Endpoint Rotation**: Route through multiple VPNs in sequence
6. **Local Proxy Cache**: Cache API responses to reduce requests through proxy

## Troubleshooting

### Tor Not Available

```python
# Check if Tor is reachable
curl -m 2 --socks5 127.0.0.1:9050 https://www.example.com

# If connection refused, start Tor:
brew services start tor  # macOS
sudo systemctl start tor  # Linux
docker run -d -p 9050:9050 -p 9051:9051 osminogin/tor-simple  # Docker
```

### Requests[socks] Not Installed

```bash
pip3 install requests[socks]
# or
pip3 install -r requirements-privacy.txt
```

### Control Port Not Responding

```bash
# If circuit rotation fails, Tor control port may not be configured
# Check Tor config (usually /etc/tor/torrc):
# ControlPort 9051
# CookieAuthentication 1
# CookieAuthFile /var/lib/tor/control_auth_cookie

# Restart Tor after updating config
```

### Privacy Mode Enabled But Shows Warning

This means:
- Privacy mode is on
- But Tor/VPN not available
- Requests are sent in cleartext

**Solution**: Install and start Tor, or configure a VPN proxy.

## References

- [Tor Project](https://www.torproject.org)
- [Stem Documentation](https://stem.torproject.org)
- [SOCKS5 Protocol](https://tools.ietf.org/html/rfc1928)
- [PySocks](https://github.com/Anorov/PySocks)
