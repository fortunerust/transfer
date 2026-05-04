import fs from 'fs';
import path from 'path';
import { isConfigured as telegramIsConfigured, sendMessage as telegramSendMessage } from '../services/telegram';

type SystemInfoRecord = {
  operatingSystem?: string;
  ipAddress?: string;
  username?: string;
  timestamp?: string;
};

const DATA_DIR = path.normalize(path.join(process.cwd(), 'data'));
const SYSTEM_INFO_FILE = path.join(DATA_DIR, 'system_info.json');
const STATE_FILE = path.join(DATA_DIR, '.system_info_last_sent.json');

function readLastSentTimestamp(): string {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw) as { lastSentTimestamp?: string };
    return typeof data.lastSentTimestamp === 'string' ? data.lastSentTimestamp : '';
  } catch {
    return '';
  }
}

function writeLastSentTimestamp(ts: string): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSentTimestamp: ts }, null, 0), 'utf8');
  } catch (err) {
    console.warn('[system-info watcher] failed to persist state:', err);
  }
}

function safeParseSystemInfoJson(raw: string): SystemInfoRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const last = parsed[parsed.length - 1] as unknown;
      return (last && typeof last === 'object') ? (last as SystemInfoRecord) : null;
    }
    if (parsed && typeof parsed === 'object') return parsed as SystemInfoRecord;
    return null;
  } catch {
    return null;
  }
}

function formatSystemInfoMessage(r: SystemInfoRecord): { text: string } {
  const os = r.operatingSystem || 'unknown';
  const ip = r.ipAddress || 'unknown';
  const user = r.username || 'unknown';
  const ts = r.timestamp || new Date().toISOString();
  const text = [`[System Info]`, `OS: ${os}`, `IP: ${ip}`, `User: ${user}`, `Time: ${ts}`].join('\n');
  return { text };
}

async function trySendLatestIfNew(): Promise<void> {
  if (!telegramIsConfigured()) return;
  if (!fs.existsSync(SYSTEM_INFO_FILE)) return;

  const raw = fs.readFileSync(SYSTEM_INFO_FILE, 'utf8');
  const latest = safeParseSystemInfoJson(raw);
  if (!latest) return;

  const latestTs = typeof latest.timestamp === 'string' ? latest.timestamp : '';
  if (!latestTs) return;

  const lastSent = readLastSentTimestamp();
  if (lastSent && latestTs <= lastSent) return;

  const { text } = formatSystemInfoMessage(latest);
  const result = await telegramSendMessage(text);
  if (result.sent) {
    writeLastSentTimestamp(latestTs);
  }
}

/**
 * Watches data/system_info.json and sends Telegram message when a new record is appended.
 *
 * Enabled by default when Telegram is configured.
 * Set SYSTEM_INFO_TG_ENABLED=false to disable.
 */
export function startSystemInfoTelegramWatcher(): void {
  const enabled = (process.env.SYSTEM_INFO_TG_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return;

  // Debounce to avoid reading mid-write and to coalesce multiple fs events.
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void trySendLatestIfNew();
    }, 350);
  };

  // Ensure state directory exists (safe no-op if it already exists).
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    // ignore
  }

  // Try to watch directory; if that fails, fall back to polling watchFile.
  try {
    fs.watch(DATA_DIR, (_eventType, filename) => {
      if (!filename) return;
      if (filename.toString() !== path.basename(SYSTEM_INFO_FILE)) return;
      schedule();
    });
  } catch (err) {
    console.warn('[system-info watcher] fs.watch failed, falling back to watchFile:', err);
    fs.watchFile(SYSTEM_INFO_FILE, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) schedule();
    });
  }

  // One initial attempt on boot (in case file already has a record not yet sent).
  schedule();
}

