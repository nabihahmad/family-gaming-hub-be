# Family Games Portal — Backend Instructions (GitHub Copilot)

> Save this file as `.github/copilot-instructions.md` in the backend repo so Copilot uses it automatically.
> The WebSocket protocol in section 5 is a contract with the frontend (built separately in Lovable). Keep it identical to the frontend's `lib/protocol.ts`. When it changes, update both.

---

## 1. Project summary

A realtime backend for family party games played on phones: **Codenames**, **Imposter**, and **One Night Werewolves**. The admin signs in, shares a temporary guest access code, creates rooms, and guests join with the shared code and room code. The server is **authoritative** and sends each player only the information they are allowed to see.

Primary goals: fast to set up, low latency, simple to run on free tiers, easy to add games.

## 2. Tech stack and constraints

- **Node.js 20+ and TypeScript** (strict mode).
- HTTP: **Fastify** (or Express if you prefer) for REST endpoints.
- WebSocket: **`ws`** library on the same HTTP server, path `/ws`.
- DB: **MongoDB** with the official `mongodb` driver. Used for admin credentials and the card/pack catalog.
- Validation: **zod** for every incoming WebSocket message and HTTP body.
- Tests: **Vitest**.
- Lint/format: ESLint + Prettier.
- Deployed on **Render.com free web service** (single instance, spins down after inactivity). Frontend is a static SPA on Netlify.
- **Live room and access-session state is in memory.** Do not add Redis or a SQL database. Admin user credentials are stored in MongoDB using a password hash.
- Single instance only: do not design for horizontal scaling.

### Environment variables

| Name | Purpose |
|---|---|
| `PORT` | HTTP port (Render sets it) |
| `MONGODB_URI` | MongoDB connection string |
| `MONGODB_DB` | Database name |
| `ALLOWED_ORIGINS` | Comma-separated frontend origins for CORS and WebSocket origin check |
| `ADMIN_TOKEN` | Bearer token for `/api/admin/*` |
| `ADMIN_USERNAME` | Username upserted into MongoDB by `npm run seed:admin` |
| `ADMIN_PASSWORD` | Password hashed and upserted by `npm run seed:admin` (minimum 12 characters) |
| `CARD_CACHE_TTL_SECONDS` | Card cache refresh interval (default 300) |
| `CODENAMES_SPYMASTER_INITIAL_SECONDS` | First spymaster clue timer (default 120) |
| `CODENAMES_SPYMASTER_ROUND_DECREMENT_SECONDS` | Reduction applied to a team's spymaster timer on each later turn (default 15) |
| `CODENAMES_SPYMASTER_MINIMUM_SECONDS` | Minimum spymaster clue timer (default 15) |
| `CODENAMES_GUESSER_SECONDS_PER_WORD` | Guess time for each clue word (default 30) |

## 3. Architecture

```
Browser (React SPA) <-- WebSocket JSON --> Node server --> MongoDB (cards/packs only)
                                              |
                                      in-memory RoomManager
                                      -> Room (one per code) -> Game module instance
```

Key rules:
1. **Each room owns its state and processes events one at a time** (a simple async queue per room). No two events for the same room run concurrently.
2. **Games are pluggable modules** behind one interface. The room/lobby/connection code never contains game rules.
3. **Per-player projection:** after every state change, the server calls `game.view(state, playerId)` for each connected player and sends that player's own view. Secrets (Codenames key card, Imposter word, Werewolves roles) are **never** included in another player's view and **never** logged.
4. **Full snapshots, not deltas.** On every change, send `room_state` and `game_view`. This makes reconnect trivial.
5. **Cards are cached in memory** and refreshed from MongoDB on an interval, so game start never waits on the DB.

### Suggested folder structure
```
src/
  index.ts                 // bootstrap: http + ws + cache warmup
  config.ts                // env parsing (zod)
  http/
    routes.ts              // /health, /api/rooms, /api/packs
    admin.ts               // /api/admin/*
  ws/
    server.ts              // upgrade, origin check, connection lifecycle
    handlers.ts            // dispatch by message type
  protocol/
    types.ts               // TS types (section 5)
    schemas.ts             // zod schemas for client messages
  rooms/
    RoomManager.ts         // create/get/cleanup rooms
    Room.ts                // players, host, phase, event queue, broadcast
  games/
    types.ts               // GameModule interface
    registry.ts            // id -> module
    codenames/ (index.ts, logic.ts, view.ts)
    imposter/  (index.ts, logic.ts, view.ts)
    werewolves/ (index.ts, roles/*.ts, night.ts, view.ts)  // phase 3
  cards/
    repo.ts                // Mongo access
    cache.ts               // in-memory cache + refresh
    selection.ts           // pick N cards by lang/game/packs
    normalize.ts           // Arabic/English normalization
  util/ (rng.ts, roomCode.ts, sanitize.ts)
test/
```

## 4. Game module interface

```ts
export interface GameContext {
  players: { id: string; name: string }[];
  options: GameOptions;
  cards: Card[];                  // already selected for lang/game/packs
  rng: () => number;              // injectable RNG (seedable for tests)
  now: () => number;
}

export interface GameModule<S = unknown, E = unknown, V = unknown> {
  id: GameId;
  minPlayers: number;
  maxPlayers: number;
  cardsNeeded?(options: GameOptions, playerCount: number): number; // e.g. 25 for codenames, 1 for imposter
  init(ctx: GameContext): S;
  handle(state: S, playerId: string, event: E, ctx: GameContext): { state: S } | { error: { code: string; message: string } };
  view(state: S, playerId: string): V;           // per-player projection, MUST NOT leak secrets
  onPlayerRemoved?(state: S, playerId: string): S;
}
```
- Game logic is pure where possible (state in, state out) so it is easy to unit test.
- Timers (Werewolves night/day) are scheduled by the Room, which injects the result as an internal event. Send `endsAt` (epoch ms) in views so clients can render countdowns.

## 5. Protocol (contract with the frontend)

All WebSocket messages are JSON: `{ "type": string, "payload": object }`. Validate every client message with zod; on failure reply with an `error` and do not crash.

### 5.1 HTTP
- `GET /health` → `{ ok: true }` (used by the frontend to wake the server)
- `POST /api/auth/login` verifies the seeded admin credentials and returns a bearer session plus an 8-character guest access code.
- `POST /api/auth/guest` exchanges the guest access code for a guest bearer session; `GET /api/auth/me` checks a session; `POST /api/auth/logout` revokes it.
- Admin logout revokes the active guest code, all guest sessions, and their active WebSocket connections.
- `POST /api/rooms` → `{ code }` (4 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, admin only)
- `GET /api/rooms/:code` → `{ exists: boolean, game?: GameId, phase?: "lobby"|"playing" }` (admin or guest session required)
- `GET /api/packs?game=codenames|imposter&lang=en|ar` → `[{ id, name, count }]` where `name` is in the requested language and `count` is the number of active cards available in that language for that game (admin or guest session required)
- CORS restricted to `ALLOWED_ORIGINS`.

### 5.2 Types
```ts
type GameId = "codenames" | "imposter" | "werewolves";
type Lang = "en" | "ar";

interface Player { id: string; name: string; connected: boolean; }

interface GameOptions {
  lang: Lang;
  packs?: string[];
  imposters?: number;      // imposter, default 1, max floor((players-1)/2) but at least 1
  roles?: string[];        // werewolves
  nightDiscoveries?: boolean; // werewolves, defaults to true
}

interface RoomState {
  code: string;
  hostId: string;
  phase: "lobby" | "playing";
  game?: GameId;
  options?: GameOptions;
  players: Player[];
}
```

### 5.3 Client → server

| type | payload | notes |
|---|---|---|
| `join` | `{ roomCode, name, accessToken, playerId?, token? }` | Requires an active admin or guest access session. If `playerId` and `token` match an existing player of that room → reconnect (mark connected, replace old socket). Otherwise create a new player with a server-generated public `playerId` and a secret random `token`. Name 1–20 chars, trimmed, sanitized, de-duplicated per room (append " 2"). |
| `select_game` | `{ game, options }` | Host only, lobby only. Validate options and that enough cards exist. |
| `start_game` | `{}` | Host only. Checks min/max players, selects cards, calls `init`. |
| `game_event` | `{ name, data? }` | Routed to the active game's `handle`. |
| `back_to_lobby` | `{}` | Host only. Discards game state. |
| `ping` | `{}` | Reply `pong`. |

### 5.4 Server → client

| type | payload |
|---|---|
| `joined` | `{ playerId, token, roomCode }` |
| `room_state` | `RoomState` (broadcast on every change) |
| `game_view` | `{ game, view }` (individual projection per player) |
| `error` | `{ code, message }` |
| `pong` | `{}` |

Error codes: `ROOM_NOT_FOUND`, `ROOM_FULL`, `NOT_HOST`, `INVALID_PHASE`, `INVALID_MESSAGE`, `NOT_ENOUGH_PLAYERS`, `NOT_ENOUGH_CARDS`, `NOT_ALLOWED`, `INVALID_ACTION`.

### 5.5 Room rules
- Max 12 players per room. Rooms are created via the HTTP endpoint and stay in memory.
- Host = first player; if the host disconnects for > 30 seconds, promote the next connected player (oldest join) and broadcast.
- A disconnected player stays in the room (shown as `connected: false`) so they can rejoin mid-game. Remove them only on explicit leave or after 30 minutes of absence while in the lobby.
- **Heartbeat:** the client sends `ping` every 25s. Also use WebSocket protocol-level ping/terminate for dead sockets (every 30s).
- **Cleanup:** delete rooms with no connected players for 2 hours.
- Origin check on the WebSocket upgrade against `ALLOWED_ORIGINS`. Rate-limit messages per connection (e.g. 20/second) and cap message size (e.g. 4KB).

## 6. Cards and MongoDB

### 6.1 Collections
```ts
// packs
{ _id: "animals", name: { en: "Animals", ar: "حيوانات" }, games: ["codenames","imposter"], active: true }

// cards: one concept with a translation per language
{
  _id: ObjectId,
  games: ["codenames", "imposter"],
  pack: "animals",
  active: true,
  en?: { word: string, hint?: string },
  ar?: { word: string, hint?: string },
  enNorm?: string,     // lowercase, trimmed, collapsed whitespace
  arNorm?: string,     // normalized Arabic (see below)
  updatedAt: Date
}
```

- A card may exist in only one language. It is only eligible for games in languages it has.
- Indexes: `{ active: 1, games: 1, pack: 1 }`; unique partial index on `enNorm` (where it exists) and on `arNorm` (where it exists).
- **Arabic normalization** (`normalize.ts`): remove tashkeel and tatweel; unify alef forms (أ إ آ → ا); normalize ى→ي and ة→ه for the dedupe key only (never alter the displayed word); trim and collapse whitespace.
- Soft delete only (`active: false`).

### 6.2 Cache and selection
- On boot, load all active cards and packs into memory (`cards/cache.ts`), then refresh every `CARD_CACHE_TTL_SECONDS` and on `POST /api/admin/reload`. If a refresh fails, keep serving the previous cache and log a warning.
- `selection.ts`: given `{ game, lang, packs }` return eligible cards (has the language field, is active, supports the game, in selected packs), shuffle with the injected RNG, take N.
  - Codenames: N = 25 distinct words. Also avoid two words with the same normalized form.
  - Imposter: N = 1.
- `GET /api/packs` computes counts from the cache. Codenames needs ≥ 25 cards in the chosen language across selected packs; reject `select_game`/`start_game` with `NOT_ENOUGH_CARDS` otherwise.
- The client never accesses MongoDB. Words are selected at game start and live in the game state.

### 6.3 Admin API (for editing without redeploying)
All require `Authorization: Bearer ${ADMIN_TOKEN}` (constant-time comparison); return 401 otherwise.

- `GET /api/admin/cards?pack=&game=&q=&page=&limit=`
- `POST /api/admin/cards` (create; compute norm fields; reject duplicates with 409)
- `PUT /api/admin/cards/:id`
- `DELETE /api/admin/cards/:id` (sets `active: false`)
- `POST /api/admin/cards/import` (array of cards, partial success report with per-row errors)
- `GET/POST/PUT /api/admin/packs`
- `POST /api/admin/reload` (refresh cache now)
- Also provide `npm run seed` that imports `seed/cards.json` (a few packs in English and Arabic) so the app works out of the box.

## 7. Game specifications

### 7.1 Codenames
- Players: min 4, max 12. Language-agnostic logic; words come from `ctx.cards`.
- Setup phase: players choose team (`set_team`), each team needs one spymaster (`become_spymaster`, only if none), host sends `begin` when each team has a spymaster and at least one operative.
- Board: 25 words. Starting team (random) has **9** words, the other **8**, **7** neutral, **1** assassin. The key card is generated at `begin` with the RNG.
- Turn: the active team's spymaster submits `give_clue` `{ text, number }`; the clue and number are public to all players. `number: 0` means unlimited guesses. Active-team operatives may then `reveal` `{ index }` up to `number + 1` cards (unlimited for zero), or use `end_turn` earlier. Spymasters cannot reveal. Reveal result:
  - own color → continue (the team may keep guessing; they can `end_turn` at any time)
  - neutral → turn ends
  - opponent color → turn ends and that team's remaining count decreases
  - assassin → the revealing team loses immediately
  - a team wins when all its words are revealed
- Timers: each team's spymaster starts with 120 seconds, then loses 15 seconds on each later turn for that team, to a 15-second minimum. Guessers get 30 seconds per clue word; a zero/unlimited clue uses that team's remaining words. Expiration forfeits the turn. All durations are configurable with the `CODENAMES_*_SECONDS` environment variables above.
- Hint history: every clue and its number is appended to a public chronological log for all players.
- Views: operatives get `color` **only** for revealed cards. Spymasters get `color` for **all** cards. Never include the key card for operatives.
- Events: `set_team`, `become_spymaster`, `begin`, `give_clue`, `reveal`, `end_turn`.
- View shape: `CodenamesView` as defined in the frontend file (phase, lang, teams, myTeam, isSpymaster, board, turn, remaining, `endsAt`, `clueLog`, winner).

### 7.2 Imposter
- Players: min 3, max 12. Options: `imposters` (default 1).
- At `init`: pick one card; use `{lang}.word` as the word and `{lang}.hint` (if any) as the hint; randomly choose imposters.
- Phases: `reveal` → `discussion` → `result`.
- Events: `ready` (marks the player as having seen their role; when all connected players are ready → `discussion`), `reveal_imposter` (host only, → `result`), `next_round` (host only, new card + new imposters, back to `reveal`).
- Views: crew get `word` (and `hint`); imposters get `isImposter: true` and `hint` only (never the word) until `result`. Include `readyCount`, `totalPlayers`, `iAmReady`. In `result`, everyone gets `result: { imposters: string[] (names), word }`.

### 7.3 Werewolves (One Night) — phase 3
- Players: min 3, max 10. The number of role cards = players + 3 (3 in the center).
- Default role sets by player count are defined in code (config object); the host may pass `roles` in options. Validate that the count equals players + 3 and that required pairs make sense (e.g. at least one werewolf-team card).
- Role ids: `doppelganger`, `werewolf`, `minion`, `mason`, `seer`, `robber`, `troublemaker`, `drunk`, `insomniac`, `villager`, `hunter`, `tanner`.
- Phases: `role_reveal` → `night` → `day` → `vote` → `result`.
  - `role_reveal`: each player sees their role; `ack_role` when seen.
  - `night`: run roles in the canonical order (doppelganger, werewolf, minion, mason, seer, robber, troublemaker, drunk, insomniac). Only roles present in the game take a step. Night powers belong to the originally dealt role: a Robber who steals a role card does not gain its power, and the original role holder still performs that role's action. A player acts at most once per night. The player originally dealt the Insomniac card always checks their final card at the end of the night, even if it changed; stealing that card does not grant another player an Insomniac check. For each step, the server sends the prompt only to the acting player(s); everyone else gets a neutral "night" view. **Each step has a minimum duration (e.g. 8–15 seconds) even if no player acts or the player acts quickly**, so timing doesn't reveal who holds which role. Roles that exist only in the center still run their step on a timer.
  - Each role is a small module: `(state, action) => { state, privateResult }`, with a validated action schema. Actions are `night_action` `{ targets: string[] }` where targets are player ids or `center:0|1|2`.
  - `day`: a timer (default 5 minutes, configurable) with `endsAt`; host can end it early.
  - `vote`: `vote` `{ target }`, secret until all have voted or the 10-second timer expires. The host may end the day early to start this vote.
  - `result`: reveal everyone's final role (after swaps), compute the winners (werewolf team, villager team, tanner), and handle ties and the hunter's chain kill. A tie kills nobody and gives the Werewolf team the win.
- Views: never reveal original/current roles other than what the player legitimately learned. At the start of day, expose only the roles selected at game setup (original player roles plus the original center cards) to everyone without revealing who holds them; group duplicate roles with counts. Night swaps and Doppelganger copies do not change this roster. Keep each player's observed card results in their private projection through the discussion and vote phases; the Robber sees their swapped-in card, the Seer sees selected cards, and the player originally dealt the Insomniac card sees their final card. When `nightDiscoveries` is enabled (default), show the discoveries panel to everyone during discussion and voting, but reveal its player-specific contents only while held. When disabled, omit the panel and its discovery data from every player's view.
- Events: `ack_role`, `night_action`, `vote`, `end_day` (host), `end_game` (host; ends the discussion early and starts the 10-second vote), `next_game` (host).

## 8. Security and robustness
- Never trust client data. Validate everything with zod; authorize every event (is the sender the host? is it their turn? is the phase right?).
- Passwords are stored with a salted scrypt hash. Access codes and bearer sessions are random; only their hashes are used to validate guest codes and access sessions.
- Admin logout revokes the active access code and every session under it, closes their WebSockets, and makes subsequent HTTP and WebSocket actions fail authorization.
- `playerId` is a public opaque id (used in views and as action targets). `token` is a secret random value (at least 128 bits) returned only in `joined` and required to rejoin as that player. Never include tokens in any broadcast or view.
- Sanitize player names (strip control characters, limit length). Do not render HTML.
- Never log secrets: no words, key cards, roles, or tokens in logs.
- Catch errors per message and per room so one bad event cannot crash the process.
- Graceful shutdown: close sockets with a clear code on SIGTERM.
- Keep dependencies minimal.

## 9. Testing
- Unit tests for each game's logic with a seeded RNG: setup, every event, win conditions, illegal actions.
- **Projection tests are mandatory:** for every game and phase, assert that no other player's secret appears anywhere in `JSON.stringify(view(state, otherPlayerId))`.
- Tests for card selection (language filter, duplicates, not enough cards) and Arabic normalization.
- A WebSocket integration test: create room, two clients join, select a game, start, play a few events, reconnect with the token.

## 10. Coding conventions for Copilot
- TypeScript strict, no `any`. Use discriminated unions for events and states.
- Small modules, pure functions for game rules, dependency injection for RNG and time.
- Prefer clear names and short comments for non-obvious rules (especially Werewolves).
- Don't add libraries, endpoints, or features that are not in this document without asking.
- Do not add Redis, an ORM, or a SQL database.
- Keep responses of `game_view` small; do not send data the client can derive.

## 11. Build order
1. Project setup, config, `/health`, RoomManager, WebSocket join/reconnect, lobby state, heartbeat, cleanup.
2. Card repo/cache/selection, `/api/packs`, seed script.
3. Imposter module + tests.
4. Codenames module + tests.
5. Admin API.
6. Werewolves module (roles, night engine, timers, votes) + tests.
7. Render deployment notes: `npm run build`, `npm start`, health check path `/health`.
