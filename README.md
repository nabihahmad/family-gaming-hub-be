# Family Gaming Hub backend

Express and WebSocket API for the Family Gaming Hub frontend. It serves the existing REST endpoints and `/ws` message protocol, keeps live rooms in memory, and stores the editable word packs and cards in MongoDB.

## Setup

1. Use Node.js 20 or later and run `npm install`.
2. Copy `.env.example` to `.env`. Set `MONGODB_URI`, `MONGODB_DB`, a private `ADMIN_TOKEN` of at least 32 characters, `ADMIN_USERNAME`, and a strong `ADMIN_PASSWORD` of at least 12 characters. Set `ALLOWED_ORIGINS` to the exact frontend origins, separated by commas.
3. Run `npm run seed:admin` to create or update the admin user using the username and password from `.env`. The password is stored as a scrypt hash, never as plaintext.
4. Seed the initial bilingual packs and cards with `npm run seed`.
5. Build and start with `npm run build` and `npm start`; use `npm run dev` while developing.
6. Configure the frontend's `VITE_API_URL` to the server's base URL and `VITE_WS_URL` to its `ws://` or `wss://` URL with `/ws`.

The server requires MongoDB to start. MongoDB stores admin credentials and the game card/pack catalog; room, game, and access-session state are intentionally in memory and will be lost when the process restarts. The admin access code and all guest sessions become invalid on restart. Rooms are single-instance and do not use Redis.

Codenames timers are configurable with `CODENAMES_SPYMASTER_INITIAL_SECONDS`, `CODENAMES_SPYMASTER_ROUND_DECREMENT_SECONDS`, `CODENAMES_SPYMASTER_MINIMUM_SECONDS`, and `CODENAMES_GUESSER_SECONDS_PER_WORD`. Defaults are 120, 15, 15, and 30 seconds respectively; see `.env.example`.

## API

- `GET /health` → `{ "ok": true }`
- `POST /api/auth/login` verifies the seeded admin and returns an admin session plus an 8-character guest access code.
- `POST /api/auth/guest` exchanges the shared access code for a guest session; `GET /api/auth/me` checks the current session.
- `POST /api/auth/logout` revokes the admin session, access code, all guest sessions, and their active WebSockets. Guest logout only revokes that guest session.
- `POST /api/rooms` → `{ "code": "ABCD" }` (admin only)
- `GET /api/rooms/:code` → room existence, game, and phase (admin or guest session required)
- `GET /api/packs?game=codenames|imposter&lang=en|ar` → localized active packs and available-card counts (admin or guest session required)
- `GET|POST /api/admin/cards`, `PUT|DELETE /api/admin/cards/:id`, `POST /api/admin/cards/import`
- `GET|POST /api/admin/packs`, `PUT /api/admin/packs/:id`, `POST /api/admin/reload`

The authenticated application routes and WebSocket join require `Authorization: Bearer <accessToken>` (the token is included in the WebSocket join message). Only the admin session that owns a room can create it or perform host actions. Admin card/pack routes separately require `Authorization: Bearer <ADMIN_TOKEN>`. Card and pack edits become available through the in-memory cache immediately; the cache also refreshes on its configured interval.

WebSocket clients connect to `/ws`. Messages and per-player game projections follow the contract in `.github/copilot-instructions.md` and the frontend's `src/lib/protocol.ts`.

## Checks and deployment

Run `npm test`, `npm run lint`, and `npm run build`. For Render, use `npm install && npm run build` as the build command and `npm start` as the start command; configure the environment variables above and use `/health` as the health-check path. MongoDB must be reachable from the service.
