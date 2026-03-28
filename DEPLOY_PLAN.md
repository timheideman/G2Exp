# LiveCaption — VPS Deployment Plan

> Permanent deployment on our Hetzner VPS so you can use the app from anywhere,
> on any network, without a laptop running locally.

---

## Architecture

```
iPhone (Even AI app)
  │
  ├─ HTTPS  → https://livecaption.astralate.com      (Caddy → static frontend)
  └─ WSS    → wss://livecaption.astralate.com/ws     (Caddy → WS server :8091)
```

- **Frontend**: Vite production build served as static files by Caddy
- **Backend**: Node.js WebSocket server running as a systemd service
- **SSL**: Automatic via Caddy + Let's Encrypt (behind Cloudflare)
- **Process management**: systemd (consistent with rest of the VPS)

The WebSocket server runs on port **8091** internally (avoiding conflict with
anything else on the VPS). Caddy proxies `/ws` on port 443 → localhost:8091.

---

## Pre-flight Checklist

Before you start, confirm you have:

- [ ] SSH access to the VPS (`ssh root@morpheus.astralate.com` or IP)
- [ ] A valid Deepgram API key (from console.deepgram.com)
- [ ] Git push access to `timheideman/G2Exp` on GitHub
- [ ] `livecaption.astralate.com` DNS A record pointing to the VPS IP ← **do this first**

---

## Step 1 — Add DNS Record in Cloudflare

1. Log in to Cloudflare → astralate.com → DNS
2. Add a new **A record**:
   - Name: `livecaption`
   - IPv4: `<VPS IP>`
   - Proxy status: **Proxied** (orange cloud ✅)
3. Save. Propagation is instant with Cloudflare.

---

## Step 2 — Code change: production WebSocket URL

The client currently derives the WS URL from `window.location.hostname` on port 8080.
In production it needs to use WSS on the same domain via the `/ws` path.

Open `src/main.ts` (or wherever `WS_URL` is defined — search for `ws://`) and update
the URL logic to:

```typescript
const isSecure = window.location.protocol === 'https:';
const wsProtocol = isSecure ? 'wss' : 'ws';
const wsPort = isSecure ? '' : ':8080';  // no port needed in production (Caddy handles it)
const wsPath = isSecure ? '/ws' : '';
const WS_URL = `${wsProtocol}://${window.location.hostname}${wsPort}${wsPath}`;
```

This means:
- **Dev** (HTTP localhost): connects to `ws://localhost:8080` — unchanged
- **Production** (HTTPS): connects to `wss://livecaption.astralate.com/ws` — via Caddy

Commit this change before continuing.

---

## Step 3 — SSH into the VPS

```bash
ssh root@<VPS_IP>
```

---

## Step 4 — Clone the repo on the VPS

```bash
cd /opt
git clone https://github.com/timheideman/G2Exp.git livecaption
cd livecaption
```

If the repo is private, you'll need to either:
- Use a deploy key (`ssh-keygen -t ed25519`, add public key to GitHub repo → Settings → Deploy keys)
- Or use a GitHub personal access token in the clone URL:
  `git clone https://<TOKEN>@github.com/timheideman/G2Exp.git livecaption`

---

## Step 5 — Install Node dependencies

```bash
cd /opt/livecaption
npm ci --omit=dev
```

> `--omit=dev` skips test/build tooling. We build locally and deploy the `dist/` folder,
> so the server only needs runtime deps (`ws`, `@deepgram/sdk`, `dotenv`).

---

## Step 6 — Create the environment file

```bash
nano /opt/livecaption/.env
```

Contents:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
WS_PORT=8091
DG_MODEL=nova-3
DG_REGION=eu
```

Save and exit (`Ctrl+X → Y → Enter`). Lock down the permissions:

```bash
chmod 600 /opt/livecaption/.env
```

---

## Step 7 — Build the frontend locally, push dist/

The cleanest approach is to build on your laptop and commit `dist/` to a deploy branch
(avoids needing Vite on the VPS — it's a dev tool, not a runtime dep).

On your **laptop**:

```bash
cd G2Exp
npm run build        # outputs to dist/
git add dist/ -f     # dist/ is gitignored by default — force add it
git commit -m "chore: production build for deployment"
git push
```

Then on the **VPS**:

```bash
cd /opt/livecaption
git pull
```

> Alternatively, you can install dev deps on the VPS and run `npm run build` there.
> Either works — the commit approach keeps the VPS lean.

---

## Step 8 — Create the systemd service

```bash
nano /etc/systemd/system/livecaption.service
```

Contents:

```ini
[Unit]
Description=LiveCaption WebSocket Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/livecaption
ExecStart=/usr/bin/node --import tsx/esm src/server/index.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/livecaption/.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=livecaption

[Install]
WantedBy=multi-user.target
```

> We use `tsx` to run TypeScript directly (it's in devDependencies — install it globally
> or use `npx tsx` as the ExecStart command if needed).
>
> **Alternative**: pre-compile with `npx tsc` and run `node dist-server/server/index.js`.
> See the "Optional: Compile server TypeScript" note at the end.

Enable and start the service:

```bash
systemctl daemon-reload
systemctl enable livecaption
systemctl start livecaption
systemctl status livecaption
```

You should see `Active: active (running)`. Check logs with:

```bash
journalctl -u livecaption -f
```

---

## Step 9 — Configure Caddy

Open the Caddyfile:

```bash
nano /etc/caddy/Caddyfile
```

Add a new site block (append below the existing ones):

```caddy
livecaption.astralate.com {
    # Proxy WebSocket connections at /ws → WS server
    handle /ws {
        reverse_proxy localhost:8091 {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
        }
    }

    # Serve static frontend for everything else
    handle {
        root * /opt/livecaption/dist
        file_server
        try_files {path} /index.html
    }

    # Trust Cloudflare proxy headers
    trusted_proxies static 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 104.16.0.0/13 104.24.0.0/14 108.162.192.0/18 131.0.72.0/22 141.101.64.0/18 162.158.0.0/15 172.64.0.0/13 173.245.48.0/20 188.114.96.0/20 190.93.240.0/20 197.234.240.0/22 198.41.128.0/17
}
```

Reload Caddy:

```bash
systemctl reload caddy
```

Check for config errors first:

```bash
caddy validate --config /etc/caddy/Caddyfile
```

---

## Step 10 — Open firewall for port 8091 (internal only)

Port 8091 is internal — Caddy proxies it, the outside world never hits it directly.
The existing ufw rules are fine as-is (80/443 Cloudflare-only). No changes needed.

Verify the WS server is actually listening:

```bash
ss -tlnp | grep 8091
```

---

## Step 11 — Test the deployment

1. On your iPhone, open the Even AI app
2. Go to **Settings → Developer** (or wherever you load a custom app URL)
3. Enter: `https://livecaption.astralate.com`
4. The app should load and connect — you'll see `🔗 Opening Deepgram...` in server logs:
   ```bash
   journalctl -u livecaption -f
   ```
5. Speak — captions should appear on your G2 glasses

---

## Step 12 — Verify WSS is working

From a browser on any device:

```javascript
// Open browser console on https://livecaption.astralate.com and run:
const ws = new WebSocket('wss://livecaption.astralate.com/ws');
ws.onopen = () => console.log('✅ WSS connected');
ws.onerror = (e) => console.error('❌ Error', e);
```

---

## Updating the deployment

When you push new code:

```bash
# On your laptop
npm run build
git add dist/ -f
git commit -m "chore: update production build"
git push

# On the VPS
cd /opt/livecaption
git pull
systemctl restart livecaption
```

For server-only changes (no frontend changes), just:

```bash
cd /opt/livecaption && git pull && systemctl restart livecaption
```

---

## Monitoring & Logs

```bash
# Live server logs
journalctl -u livecaption -f

# Last 100 lines
journalctl -u livecaption -n 100

# Check service health
systemctl status livecaption

# Restart if needed
systemctl restart livecaption
```

---

## Optional: Compile server TypeScript (cleaner production setup)

Instead of running TypeScript directly with `tsx`, you can add a proper server build step.

Add to `package.json` scripts:

```json
"build:server": "tsc --project tsconfig.server.json"
```

Create `tsconfig.server.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist-server",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022"
  },
  "include": ["src/server/**/*", "src/types/**/*"]
}
```

Then update the systemd `ExecStart` to:

```
ExecStart=/usr/bin/node dist-server/server/index.js
```

And add `npm run build:server` to your deploy step.

---

## Cost estimate

| Item | Cost |
|------|------|
| VPS hosting | Already running (existing bill) |
| Deepgram transcription | ~$0.009/min (~$0.54/hr of active speech) |
| SSL cert | Free (Let's Encrypt via Caddy) |
| **Total new cost** | **Deepgram usage only** |

---

*Written: 2026-03-28*
