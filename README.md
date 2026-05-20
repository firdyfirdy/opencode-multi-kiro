# @firdyfirdy/opencode-multi-kiro

OpenCode plugin to connect to Kiro **without a hosted gateway**.

The plugin runs directly inside the OpenCode process, intercepts OpenAI-compatible requests, and translates them into Kiro native requests (`/generateAssistantResponse`).

---

## ⚠️ Requirements

- **OpenCode v1.15.0 or later** — older versions have incompatible plugin API
- **kiro-cli** — for account authentication

```bash
# Check your OpenCode version
opencode --version

# Upgrade if needed
opencode upgrade
```

---

## Quick Start

### 1. Install kiro-cli

```bash
npm install -g kiro-cli
```

### 2. Login to Kiro

```bash
# Login via browser
kiro auth login
```

### 3. Install the plugin

```bash
opencode plugin @firdyfirdy/opencode-multi-kiro
```

### 4. Connect provider in OpenCode

```bash
opencode
# Then run: /connect
# Select: kiro
# Choose: Kiro (sync from kiro-cli)
```

### 5. Setup agent (optional)

Add to `~/.config/opencode/opencode.json`:

```json
{
  "agent": {
    "kiro-build": {
      "mode": "primary",
      "model": "kiro/claude-opus-4-6"
    }
  }
}
```

Available models: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`, etc.

---

## Core Architecture

### 1) Embedded Plugin (No Gateway)

```text
OpenCode
  -> plugin fetch hook (src/index.ts)
  -> request transform (src/transform.ts)
  -> Kiro runtime API call
  -> AWS event stream parsing (src/stream.ts)
  -> OpenAI SSE response back to OpenCode
```

No separate Python server is required.

---

### 2) Multi-Account Store

Accounts are persisted in:

```text
~/.config/opencode/multi-kiro.json
```

Stored fields include:
- email
- access_token
- refresh_token
- expires_at
- health state (`is_healthy`, `last_error`, `cooldown_until`)
- usage and request metrics

---

### 3) Token Forking (Decoupled from kiro-cli)

This is a key mechanism.

When the plugin syncs a token from `kiro-cli`, it **immediately refreshes it once** to create its own token chain:

```text
kiro-cli token: RT-A
      |
      | sync + immediate refresh (fork)
      v
plugin token: RT-B (new rotated token)
```

Meaning:
- `kiro-cli` keeps token A
- plugin stores token B
- plugin persists token B to `multi-kiro.json`

Goal: plugin tokens are not tightly coupled to the exact token currently held by kiro-cli.

> Note: if Kiro server revokes the entire session on logout, forked tokens may still become invalid. That behavior is server-side.

---

### 4) Rotating Refresh Tokens

Kiro uses rotating refresh tokens. Each refresh does:

```text
RT-old -> refresh -> RT-new
```

The plugin always persists the latest `refresh_token` into `multi-kiro.json` after a successful refresh.

---

### 5) Account Rotation Strategy

Strategy is stored in `multi-kiro.json`:
- `round-robin`: rotates based on `last_used`
- `hybrid`
- `sticky`

Accounts that fail refresh/request are marked unhealthy and skipped.

---

## Multi-Account Login Workflow

This is the recommended real-world flow:

1. Login on Kiro web first: `https://app.kiro.dev/`
2. Run initial CLI login:

   ```bash
   kiro-cli login
   ```

3. If successful, run OpenCode auth login for the provider:

   ```bash
   opencode auth login --provider kiro
   ```

4. Choose:
   - `Kiro (sync from kiro-cli)`
   - (not `Manage Accounts` for initial import)

5. Use OpenCode normally.

### Adding another account

Because `kiro-cli` usually handles one active account session at a time, add accounts iteratively:

1. Logout current account in CLI:

   ```bash
   kiro-cli logout
   ```

2. Repeat the same login/import flow:
   - login at `https://app.kiro.dev/`
   - `kiro-cli login`
   - `opencode auth login --provider kiro`
   - choose `Kiro (sync from kiro-cli)`

This imports the newly logged-in account into `multi-kiro.json`.

---

## Install (Local Path)

In `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-multi-kiro"]
}
```

Then restart OpenCode.

---

## Build

```bash
bun install
bun run build
```

---

## Troubleshooting

### Only one account keeps getting used

Check `~/.config/opencode/multi-kiro.json`:
- other accounts may be `is_healthy: false`
- `last_error` is often `token_refresh_failed`

Common causes:
- refresh token has been revoked/expired
- account has not been synced from the latest `kiro-cli` login session

Practical fix:
- run `opencode auth login --provider kiro`
- choose `Kiro (sync from kiro-cli)` after each fresh `kiro-cli login`

### Email shows as `kiro-desktop-us-east-1`

This is a fallback label when usage/email lookup fails. It usually indicates an invalid token or usage API failure.

### Debug Mode

For troubleshooting, enable debug logging:

```bash
# Log outbound payload before sending to Kiro
DEBUG_KIRO_PAYLOAD=1 opencode

# Log stream events from Kiro response
DEBUG_KIRO_STREAM=1 opencode

# Both
DEBUG_KIRO_PAYLOAD=1 DEBUG_KIRO_STREAM=1 opencode
```

---

## Source Map

- `src/index.ts` — plugin hooks, account selection, retries, toast
- `src/auth.ts` — kiro-cli sync, token refresh, token forking
- `src/transform.ts` — OpenAI request -> Kiro payload
- `src/stream.ts` — AWS binary stream -> OpenAI SSE
- `src/store.ts` — JSON registry persistence
- `src/router.ts` — rotation strategy
- `src/fail.ts` — error classification
