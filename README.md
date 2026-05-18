# opencode-multi-kiro

[![npm version](https://img.shields.io/npm/v/@firdyfirdy/opencode-multi-kiro)](https://www.npmjs.com/package/@firdyfirdy/opencode-multi-kiro)
[![license](https://img.shields.io/npm/l/@firdyfirdy/opencode-multi-kiro)](./LICENSE)

OpenCode plugin for multi-account Kiro with automatic rotation, usage tracking, and account management.

## Features

- **Multi-account support** — Register and manage multiple Kiro accounts
- **Auto-rotation** — Automatically rotate between accounts to distribute usage
- **Usage tracking** — Track request counts and token usage per account
- **kiro-cli sync** — Sync accounts and tokens from kiro-cli authentication
- **Token refresh** — Automatic token refresh when credentials expire
- **Account management** — Sync/add (via `kiro-cli`), remove, activate, and refresh accounts
- **Exponential backoff** — Retry with exponential backoff on rate limits or transient errors

## Installation

Add the plugin to your `opencode.json` plugin array:

```json
{
  "plugin": [
    "@firdyfirdy/opencode-multi-kiro"
  ]
}
```

Then install:

```bash
npm install @firdyfirdy/opencode-multi-kiro
```

## Setup

1. **Login with kiro-cli**

   ```bash
   kiro-cli login
   ```

   This stores credentials that the plugin can sync from.

2. **Auth file placeholder**

   Create `~/.local/share/opencode/auth.json` if it doesn't exist:

   ```json
   {
      "kiro": {
        "type": "api",
        "key": "placeholder"
      }
    }
   ```

   Accounts will be populated automatically when you sync from `kiro-cli`.

3. **Configure the plugin**

   In your `opencode.json`:

   ```json
   {
      "plugin": [
        "@firdyfirdy/opencode-multi-kiro"
      ],
      "multi-kiro": {
        "strategy": "hybrid"
      }
   }
   ```

## Configuration

| Option     | Type   | Default  | Description                          |
|------------|--------|----------|--------------------------------------|
| `strategy` | string | `hybrid` | Account rotation strategy to use     |

### Rotation Strategies

- **`hybrid`** — Combines round-robin with usage-aware selection. Prefers accounts with lower usage, falls back to round-robin when usage is balanced.
- **`round-robin`** — Cycles through accounts sequentially in order.
- **`sticky`** — Sticks to a single account until it hits a rate limit or error, then switches.

## Available Models

| Model ID              | Description                  |
|-----------------------|------------------------------|
| `auto`                | Automatic model selection    |
| `claude-sonnet-4-5`   | Claude Sonnet 4.5            |
| `claude-sonnet-4-6`   | Claude Sonnet 4.6            |
| `claude-sonnet-4`     | Claude Sonnet 4              |
| `claude-haiku-4-5`    | Claude Haiku 4.5             |
| `claude-opus-4-5`     | Claude Opus 4.5              |
| `claude-opus-4-6`     | Claude Opus 4.6              |
| `claude-opus-4-7`     | Claude Opus 4.7              |
| `minimax-m2.5`        | MiniMax M2.5                 |
| `minimax-m2.1`        | MiniMax M2.1                 |
| `qwen3-coder-next`    | Qwen3 Coder Next             |

## Local Development

Build the plugin:

```bash
bun run build
```

Use a local file path in your `opencode.json` for development:

```json
{
    "plugin": [
      "file:///path/to/opencode-multi-kiro/dist/index.js"
    ]
}
```

## Troubleshooting

- **Accounts not syncing** — Run `kiro-cli login`, then use `Manage Accounts -> Add account (sync kiro-cli)`.
- **Token refresh failing** — Check that your refresh tokens haven't been revoked. Re-run `kiro-cli login` to re-authenticate.
- **Rate limit errors** — The plugin retries with exponential backoff automatically. If errors persist, add more accounts or switch to `round-robin` strategy.
- **Plugin not loading** — Verify the plugin is listed in your `opencode.json` `plugins` array and that the package is installed.

## License

[MIT](./LICENSE)

## Author

firdyfirdy
