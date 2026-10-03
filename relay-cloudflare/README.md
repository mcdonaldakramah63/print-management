# Receipt System relay on Cloudflare (free, no card)

The same relay as `relay/relay.js`, as a Cloudflare Worker. Each shop gets a
Durable Object holding its link (a WebSocket the shop PC keeps open, free
while idle thanks to hibernation), the requests waiting for the shop, and
its last encrypted status snapshot. The shop server notices this relay by
itself (`/healthz` says `link: "ws"`) and connects with a WebSocket.

Free plan limits are far above what a shop uses (100,000 requests a day).

## Set it up (once)

1. **Cloudflare account**: sign up at <https://dash.cloudflare.com/sign-up>
   (free, no card). Open **Workers & Pages** once and pick your
   `workers.dev` subdomain if asked.
2. **API token**: My Profile > API Tokens > Create Token > template
   **Edit Cloudflare Workers** > Continue > Create. Copy the token.
3. **Account ID**: Workers & Pages overview, right-hand side (or the URL
   `dash.cloudflare.com/<account id>/…`).
4. **GitHub secrets**: this repository > Settings > Secrets and variables >
   Actions > New repository secret, three times:
   - `CLOUDFLARE_API_TOKEN`: the token
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID
   - `RELAY_KEY`: a long random password (you'll also type it on the shop PC)
5. **Deploy**: Actions > **Cloudflare relay** > Run workflow. It tests the
   Worker, deploys it, sets the key, then runs the full end-to-end test
   against the live relay. The run summary shows the relay address,
   `https://receipt-relay.<your-subdomain>.workers.dev`.

Then on the shop PC: Settings > Remote access and phone app > relay
address + `RELAY_KEY` > switch on > Save. It shows **Connected**.

## Develop

```bash
cd relay-cloudflare && npm ci
printf 'RELAY_KEY=dev-key\n' > .dev.vars
npx wrangler dev --port 8799
RELAY_URL=http://127.0.0.1:8799 RELAY_KEY=dev-key node ../relay/test/relay.test.js
```
