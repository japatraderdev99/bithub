# Bithub — Frontend Baseline

Bithub is a descriptive read-only dashboard for crypto / macro / on-chain
data. This public repository holds the **frontend baseline** and a **local
read-worker skeleton** used for development and testing.

This baseline is descriptive, not inferential. The dashboard never shows
trade signals, scores, directions, recommendations, or order/position
state. Colors indicate operational status only — never price direction.

## What is in this repo

| Path | Role |
|---|---|
| `bithub-ui/` | Static HTML/CSS/JS read-only dashboard. ESM-native, zero third-party dependencies. |
| `bithub-read-worker/` | Read Worker serving canonical `/v1/*` envelopes from deterministic fixtures. Used locally by `bithub-ui`; deployable to Cloudflare Workers via Wrangler. |
| `.gitignore`, `.env.example` | Repo hygiene. `.env` itself never ships. |

What is **not** in this repo (kept private locally):

- Private planning notes and design documents (`bithub-vault/`)
- Data-layer Python package, fixtures, and tests (`bithub-data-layer/`)
- External templates / research material
- Any secret, token, or credential

## Cloudflare Pages settings

When the repository is connected to Cloudflare Pages, configure:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Preview branches | `preview/*` |
| Build command | *(leave empty)* |
| Build output directory | `bithub-ui/public` |
| Root directory | *(leave empty / project root)* |
| Environment variables | *(none required — frontend has no secrets)* |

The frontend is served verbatim from `bithub-ui/public/`. No build step,
no install. `bithub-ui/public/_headers` configures Cloudflare Pages HTTP
headers for the static assets.

Note: `bithub-read-worker/` can run locally through
`bithub-ui/scripts/dev-server.mjs` and can also be deployed as a
Cloudflare Worker using `bithub-read-worker/wrangler.toml`. The initial
Worker remains read-only and fixture-backed: no KV, D1, R2, Access,
Queue, Cron, Bybit private, or secret binding is required.

## Local development

Requires Node 22+. No `npm install` step.

```bash
# Start the local dev server (binds 127.0.0.1:3000 by default)
node bithub-ui/scripts/dev-server.mjs

# Then open http://127.0.0.1:3000/ in a browser.
```

The dev server serves `bithub-ui/public/` and delegates `/v1/*` requests
to the local Read Worker skeleton (imported directly, no proxy).

### Routes

| URL | View |
|---|---|
| `#/` | Dashboard (health + bundle BTC/USDT:USDT + section status grid) |
| `#/health` | Health detail by source |
| `#/config` | Public config + feature flags |
| `#/source-status` | Source event log |
| `#/bundle/BTC%2FUSDT%3AUSDT` | Bundle drill |
| `#/blobs` | Demonstrates expected 503 for blobs |
| `#/dev/states` | Operational states gallery (developer view) |

Keyboard shortcuts: `g d` / `g h` / `g c` / `g s` / `g b` / `g x` / `g v`.

## Tests

```bash
# Frontend tests (71 OK)
node --test bithub-ui/tests/*.test.mjs

# Offline smoke (14 OK)
node bithub-ui/scripts/smoke.mjs

# Read Worker skeleton tests (50 OK)
node --test bithub-read-worker/tests/read-worker.test.mjs
```

## Restrictions

This baseline deliberately excludes the following until separately
authorized:

- No real Cloudflare resources (KV, D1, R2, Access, Workers deploy).
- No `wrangler`, `npx`, `npm install`, or any dependency install.
- No reads from `.env`, env vars, secrets, tokens, or credentials.
- No application auth, login, session, users, or roles.
- No deploy to production.
- No `POST/PUT/PATCH/DELETE` from the frontend — Worker responds 405.
- No trade, signal, score, direction, regime, order, position, wallet,
  balance, paper trading, or execution surface.

## Further reading

- `bithub-ui/README.md` — frontend layout, design system, and routes.
- `bithub-ui/ARCHITECTURE.md` — decisions and evolution path.
- `bithub-read-worker/README.md` — Worker skeleton scope and limits.

## License

Not yet defined.
