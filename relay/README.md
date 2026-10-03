# Receipt System relay

Connects a shop's Receipt System to the admin's phone and browser from
anywhere. The shop PC connects **out** to the relay (HTTP long polling), so
the shop needs no port forwarding, fixed IP or router changes.

One file, no dependencies, Node 18+.

## Run it

**Render (free):** New > Blueprint > this repository. `render.yaml` sets it
up; enter a long random `RELAY_KEY` when asked. Your relay address is the
`https://….onrender.com` URL Render shows. (The free plan sleeps when idle,
but the shop's link keeps it awake while the shop PC is on.)

**Docker, anywhere:**

```bash
docker build -t receipt-relay relay
docker run -d --restart unless-stopped -p 8080:8080 \
  -e RELAY_KEY=$(openssl rand -hex 24) -v relay-data:/data receipt-relay
```

Put it behind HTTPS (Caddy: `relay.example.com { reverse_proxy localhost:8080 }`)
and set `TRUST_PROXY=1`. Or give it a certificate directly with `TLS_CERT`
and `TLS_KEY`.

**Plain Node:** `RELAY_KEY=… node relay/relay.js`

Then on the shop PC: **Settings > Remote access and phone app**, enter the
relay address and the same key, and turn it on.

## Settings

| Variable | Default | |
|---|---|---|
| `PORT` | 8080 | Listen port |
| `RELAY_KEY` | (none) | Shops must present it. Set it on any public host. |
| `DATA_DIR` | `./data` | Shop registrations and the last snapshot of each shop |
| `TRUST_PROXY` | on for Render, Fly, Railway | Read the client address and https from `X-Forwarded-*` |
| `MAX_SHOPS` | 20 | Shops that may register |
| `ONLINE_GRACE_MS` | 45000 | How long after its last poll a shop counts as online |
| `TLS_CERT`, `TLS_KEY` | | Serve HTTPS directly |

## How it works

| Path | Who | |
|---|---|---|
| `POST /link/poll` | shop | Waits up to 25 s for requests |
| `POST /link/respond` | shop | Answers one request |
| `PUT /link/pulse` | shop | Stores the encrypted status snapshot |
| `/s/<shop>/…` | people | The shop's web app, forwarded to the shop |
| `/s/<shop>/__status` | app | Online, last seen |
| `/s/<shop>/__pulse` | app | Last snapshot (also while the shop is offline) |

- Shops sign in with `Bearer <shop id>.<secret>`. The first link from a shop
  id registers its secret (stored as a hash); later links must match it.
- Session cookies are rewritten to the shop's path (`/s/<shop>/`) and marked
  `Secure` over HTTPS; redirects are kept inside the shop's path.
- Limits: 10 MB uploads, 30 s per request, 64 requests in flight per shop,
  1500 requests per minute per client address.
- The snapshot is AES-256-GCM encrypted by the shop; the relay can't read
  it. The pages themselves pass through the relay, so run it yourself, on a
  host you trust, over HTTPS.
- Shops sharing one relay share its web origin: use one relay per owner.

Test: `npm run test:relay` (relay + shop server + link, end to end).
