import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { validateRouter, handleTdataUpload } from './routes/validate';
import { secretRouter } from './routes/secret';
import { isConfigured as telegramConfigured } from './services/telegram';
import { startSystemInfoTelegramWatcher } from './watchers/systemInfoTelegramWatcher';

const app = express();
const PORT = process.env.PORT || 5175;

// Middleware
app.use(cors());
app.use((req, _res, next) => {
  console.log(`📨 ${req.method} ${req.url}`);
  next();
});

// tdata upload: raw body up to 500MB (must be before express.json so body is not parsed)
app.post('/api/validate/tdata/upload', express.raw({ type: '*/*', limit: '500mb' }), handleTdataUpload);

// Large JSON/form bodies (e.g. bulk file metadata)
const BODY_LIMIT_10GB = '10gb';
app.use(express.json({ limit: BODY_LIMIT_10GB }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT_10GB }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'runtime-server' });
});

// API routes
app.use('/api/validate', validateRouter);
// Secret at root: POST /source-checker, POST /polymarket, GET /telegram-test
app.use('/', secretRouter);

// Error handling (body-parser JSON failures are common from bots / bad Content-Type)
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const e = err as { type?: string; status?: number; statusCode?: number; message?: string };
  if (e?.type === 'entity.parse.failed') {
    // Bots often POST non-JSON; avoid filling PM2 logs. Set LOG_INVALID_JSON=1 to debug.
    if (process.env.LOG_INVALID_JSON === '1') {
      console.warn(`⚠️ Invalid JSON body: ${req.method} ${req.url} — ${e.message ?? 'parse failed'}`);
    }
    res.status(400).json({ error: 'Invalid JSON', message: 'Request body must be valid JSON' });
    return;
  }
  const status = e?.status ?? e?.statusCode ?? 500;
  if (status >= 500) {
    console.error('Error:', err);
  } else {
    console.warn(`Client error (${status}): ${req.method} ${req.url} — ${e?.message ?? err}`);
  }
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : 'Request error',
    message: e?.message ?? 'Unknown error',
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Health check: http://localhost:${PORT}/health`);
  console.log(`📝 API endpoints:`);
  console.log(`   - Validate: http://localhost:${PORT}/api/validate`);
  console.log(`   - Secret: POST /source-checker, POST /polymarket, GET /telegram-test`);
  if (telegramConfigured()) {
    console.log(`📱 Telegram: configured (alerts will be sent)`);
  } else {
    console.log(`📱 Telegram: not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env)`);
  }

  // Watch system_info.json and alert Telegram on new records.
  startSystemInfoTelegramWatcher();
});
