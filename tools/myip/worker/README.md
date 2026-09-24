# MyIP first-party Cloudflare probe

This Worker is the first-party international-route probe for `tools/myip`.

## Design

- Returns the client IP seen by Cloudflare plus coarse network metadata already attached to the incoming Worker request.
- Makes **no outbound subrequests** and uses no KV, D1, R2, Durable Objects, Queues, or paid bindings.
- Does not persist probe results in application code.
- Restricts browser CORS access to the production site, GitHub Pages fallback, and local test origins.
- Uses `workers.dev` intentionally because it should behave as an international-route hostname for common proxy-rule setups. Do not treat `linchun.com.cn` itself as a domestic-path signal.

## Endpoints

Production base URL: `https://myip.cfw3.workers.dev`

- `GET /v1/ip` (and `/`) — IP/network probe payload.
- `GET /healthz` — service health only, without visitor IP details in the body.

## Cloudflare deployment

Current deployment is a manually created Cloudflare Worker:

- Worker name: `myip`
- workers.dev route: `https://myip.cfw3.workers.dev`
- Preview URLs: not required
- Cloudflare Access: must remain disabled for the public workers.dev route used by the browser probe
- No KV / D1 / R2 / Durable Objects / Queues / paid bindings are required

If Git integration or Wrangler deployment is enabled later, use:

- Git repository: `linchun7/linchun7.github.io`
- Production branch: `main`
- Root directory: `tools/myip/worker`
- Build command: empty
- Deploy command: `npx wrangler deploy`
- Build watch include path: `tools/myip/worker/**`

The frontend is wired to `https://myip.cfw3.workers.dev/v1/ip`. IP.SB/IPify/IPWho.is remain independent verification/fallback evidence only.
