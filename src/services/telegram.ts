/**
 * Telegram Bot API integration — configurable base URL so you can use another API (e.g. proxy or custom bot backend).
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID | TELEGRAM_GROUP_ID, optional TELEGRAM_API_BASE.
 * Env is read lazily so dotenv.config() in the app entry has run before we send.
 */
const DEFAULT_GROUP_ID = '-1003715632391';
const MAX_MESSAGE_LENGTH = 4096;

function getEnv(): { token: string; chatId: string; apiBase: string } {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const chatId =
    process.env.TELEGRAM_GROUP_ID?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    DEFAULT_GROUP_ID;
  const apiBase = (process.env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org').replace(/\/$/, '');
  return { token, chatId, apiBase };
}

export interface SendMessageOptions {
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  disable_web_page_preview?: boolean;
}

export interface TelegramApiResult {
  ok: boolean;
  description?: string;
  result?: unknown;
  error_code?: number;
}

export function isConfigured(): boolean {
  const { token, chatId } = getEnv();
  return Boolean(token && chatId);
}

export function getConfig(): { chatId: string; apiBase: string; hasToken: boolean } {
  const { token, chatId, apiBase } = getEnv();
  return {
    chatId,
    apiBase,
    hasToken: Boolean(token),
  };
}

/**
 * Send a text message to the configured chat. No-op if token or chat not set.
 * Uses TELEGRAM_API_BASE so you can point to another Bot API endpoint.
 */
export async function sendMessage(
  text: string,
  options?: SendMessageOptions
): Promise<{ sent: boolean; error?: string }> {
  const { token, chatId, apiBase } = getEnv();
  if (!token || !chatId) {
    console.warn('[Telegram] Not configured: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing');
    return { sent: false };
  }
  const trimmed =
    text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH - 1) + '…' : text;
  const url = `${apiBase}/bot${token}/sendMessage`;
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: trimmed,
      disable_web_page_preview: options?.disable_web_page_preview ?? true,
    };
    if (options?.parse_mode) payload.parse_mode = options.parse_mode;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as TelegramApiResult;
    if (!res.ok || !data.ok) {
      const err = data.description || `HTTP ${res.status}`;
      console.error('[Telegram] API error:', err, data);
      return { sent: false, error: err };
    }
    console.log('[Telegram] message sent to chat_id', chatId);
    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Telegram] send error:', err);
    return { sent: false, error: msg };
  }
}

/**
 * Send a test message and return the raw API response (for debugging and telegram-test endpoint).
 */
export async function sendTestMessage(testText?: string): Promise<{
  ok: boolean;
  message: string;
  chat_id_used: string;
  telegram_response: TelegramApiResult;
  hint?: string;
}> {
  const { chatId, apiBase, hasToken } = getConfig();
  const { token } = getEnv();
  if (!hasToken || !chatId) {
    return {
      ok: false,
      message: 'Telegram not configured',
      chat_id_used: chatId,
      telegram_response: { ok: false, description: 'Not configured' },
      hint:
        'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or TELEGRAM_GROUP_ID) in .env. Optional: TELEGRAM_API_BASE for another API.',
    };
  }
  const url = `${apiBase}/bot${token}/sendMessage`;
  const text =
    testText ||
    'Test alert from runtime-server – if you see this, Telegram is working.';
  try {
    const body = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await r.json()) as TelegramApiResult;
    const sent = data.ok === true;
    return {
      ok: sent,
      message: sent
        ? 'Test message sent – check your chat/group.'
        : (data.description || 'Unknown error'),
      chat_id_used: chatId,
      telegram_response: data,
      hint:
        !sent && data.description?.includes('chat not found')
          ? 'Add the bot to the group first. For groups chat_id must be negative. Get it from: ' +
            apiBase +
            '/bot' +
            (token ? token.slice(0, 10) + '...' : '') +
            '/getUpdates after sending a message in the group.'
          : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: msg,
      chat_id_used: chatId,
      telegram_response: { ok: false, description: msg },
    };
  }
}
