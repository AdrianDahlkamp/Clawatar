# Development Guide

## Setup

```bash
git clone <repo>
cd vrm-viewer
npm install
npm run start
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server only (port 3000) |
| `npm run ws-server` | WebSocket server only (port 8765 + 8866) |
| `npm run start` | Both dev + WS server together |
| `npm run build` | Production build |

## Code Style

- **TypeScript strict** — no `any` where avoidable
- **Modules** — each file has a single responsibility
- **State** — centralized in `main.ts`, accessed via import
- **Render loop order matters:**
  1. Animation mixer update
  2. Expression overrides
  3. Blink + lip sync
  4. VRM update (applies all changes)
  5. State machine
  6. Look-at

## Adding New Animations

1. Place `.vrma` file in the animations directory
2. The file name format is `{id}_{Name}.vrma` (e.g., `161_Waving.vrma`)
3. Use `action_id` without the `.vrma` extension in WebSocket commands
4. Add to `ALL_ACTIONS` array in `src/ui.ts` for the dropdown

## Adding New Expressions

VRM supports these preset expressions:
- `happy`, `angry`, `sad`, `surprised`, `relaxed` — emotional
- `aa`, `ih`, `ou`, `ee`, `oh` — mouth shapes (used by lip sync)
- `blink` — eye blink (used by auto-blink)
- `neutral` — reset all

Custom expressions depend on the VRM model's expression setup.

## Architecture Notes

### State Machine
The avatar has three states:
- **Idle** — base animation playing, periodic micro-actions
- **Action** — playing a requested animation, returns to idle when done
- **Speaking** — playing audio + lip sync + action, blocks idle

### Expression Override System
VRMA animations can contain expression tracks that override our manual settings.
Solution: `applyExpressionOverrides()` runs after mixer update, layering our
desired expressions on top of animation data.

### OpenClaw Integration
`server/ws-server.ts` talks to OpenClaw in this order:

1. Preferred: OpenClaw Gateway streaming API (`http://127.0.0.1:18789/v1/chat/completions`).
2. Fallback: `openclaw agent --json` CLI.
3. Last resort fallback: OpenClaw gateway `/api/agent`.

Pipeline summary:
- `user_speech` in
- OpenClaw response generation
- action/expression pick
- TTS (`speak_audio` or streaming `audio_*`)
- sync + audio broadcast to clients

### Transport Matrix

- Local web frontend:
  - Browser (`localhost:3000`) -> local WS `ws://127.0.0.1:8765` -> `ws-server.ts` -> OpenClaw.
- Apple app (iPhone/iPad/macOS):
  - App -> Relay `/ws/client` -> relay bridge `/ws/gateway` -> `ws-server.ts` (`ws://127.0.0.1:8765`) -> OpenClaw.

Important:
- Apple app does not connect directly to `:8765` or `:18789`.
- `ws-server.ts` is loopback-only by default (`CLAWATAR_ALLOW_REMOTE_WS_CLIENTS=1` disables this for LAN debugging).
- `gateway-relay-bridge.mjs` should point to app backend WS protocol (`:8765`), not OpenClaw gateway WS.
