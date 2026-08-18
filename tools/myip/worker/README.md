# MyIP first-party Cloudflare probe

This Worker is the first-party international-route probe for `tools/myip`.

## Design

- Returns the client IP seen by Cloudflare plus coarse network metadata already attached to the incoming Worker request.
- Makes **no outbound subrequests** and uses no KV, D1, R2, Durable Objects, Queues, or paid bindings.
- Does not persist probe results in application code.
- Restricts browser CORS access to the production site, GitHub Pages fallback, and local test origins.
- Uses `workers.dev` intentionally because it should behave as an international-route hostname for common proxy-rule setups. Do not treat `linchun.com.cn` itself as a domestic-path signal.

## Endpoints

- `GET /v1/ip` (and `/`) — IP/network probe payload.
- `GET /healthz` — service health only, without visitor IP details in the body.

## Cloudflare Builds

Recommended configuration:

- Worker name: `linchun-myip-probe`
- Git repository: `linchun7/linchun7.github.io`
- Production branch: `main`
- Root directory: `tools/myip/worker`
- Build command: empty
- Deploy command: `npx wrangler deploy`
- Build watch include path: `tools/myip/worker/**`
- Preview URLs: disabled (enforced in `wrangler.jsonc`)
- `workers.dev`: enabled (enforced in `wrangler.jsonc`)

After the Worker is deployed, wire its exact `https://linchun-myip-probe.<account-subdomain>.workers.dev/v1/ip` URL into the MyIP frontend and keep IP.SB/IPify/IPWho.is only as independent verification/fallback evidence.
