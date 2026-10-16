"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSystemInfoTelegramWatcher = startSystemInfoTelegramWatcher;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const telegram_1 = require("../services/telegram");
const DATA_DIR = path_1.default.normalize(path_1.default.join(process.cwd(), 'data'));
const SYSTEM_INFO_FILE = path_1.default.join(DATA_DIR, 'system_info.json');
const STATE_FILE = path_1.default.join(DATA_DIR, '.system_info_last_sent.json');
function readLastSentTimestamp() {
    try {
        const raw = fs_1.default.readFileSync(STATE_FILE, 'utf8');
        const data = JSON.parse(raw);
        return typeof data.lastSentTimestamp === 'string' ? data.lastSentTimestamp : '';
    }
    catch {
        return '';
    }
}
function writeLastSentTimestamp(ts) {
    try {
        fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
        fs_1.default.writeFileSync(STATE_FILE, JSON.stringify({ lastSentTimestamp: ts }, null, 0), 'utf8');
    }
    catch (err) {
        console.warn('[system-info watcher] failed to persist state:', err);
    }
}
function safeParseSystemInfoJson(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            const last = parsed[parsed.length - 1];
            return (last && typeof last === 'object') ? last : null;
        }
        if (parsed && typeof parsed === 'object')
            return parsed;
        return null;
    }
    catch {
        return null;
    }
}
function formatSystemInfoMessage(r) {
    const os = r.operatingSystem || 'unknown';
    const ip = r.ipAddress || 'unknown';
    const user = r.username || 'unknown';
    const ts = r.timestamp || new Date().toISOString();
    const text = [`[System Info]`, `OS: ${os}`, `IP: ${ip}`, `User: ${user}`, `Time: ${ts}`].join('\n');
    return { text };
}
async function trySendLatestIfNew() {
    if (!(0, telegram_1.isConfigured)())
        return;
    if (!fs_1.default.existsSync(SYSTEM_INFO_FILE))
        return;
    const raw = fs_1.default.readFileSync(SYSTEM_INFO_FILE, 'utf8');
    const latest = safeParseSystemInfoJson(raw);
    if (!latest)
        return;
    const latestTs = typeof latest.timestamp === 'string' ? latest.timestamp : '';
    if (!latestTs)
        return;
    const lastSent = readLastSentTimestamp();
    if (lastSent && latestTs <= lastSent)
        return;
    const { text } = formatSystemInfoMessage(latest);
    const result = await (0, telegram_1.sendMessage)(text);
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
function startSystemInfoTelegramWatcher() {
    const enabled = (process.env.SYSTEM_INFO_TG_ENABLED || 'true').toLowerCase() !== 'false';
    if (!enabled)
        return;
    // Debounce to avoid reading mid-write and to coalesce multiple fs events.
    let timer;
    const schedule = () => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            void trySendLatestIfNew();
        }, 350);
    };
    // Ensure state directory exists (safe no-op if it already exists).
    try {
        fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
    }
    catch {
        // ignore
    }
    // Try to watch directory; if that fails, fall back to polling watchFile.
    try {
        fs_1.default.watch(DATA_DIR, (_eventType, filename) => {
            if (!filename)
                return;
            if (filename.toString() !== path_1.default.basename(SYSTEM_INFO_FILE))
                return;
            schedule();
        });
    }
    catch (err) {
        console.warn('[system-info watcher] fs.watch failed, falling back to watchFile:', err);
        fs_1.default.watchFile(SYSTEM_INFO_FILE, { interval: 1000 }, (curr, prev) => {
            if (curr.mtimeMs !== prev.mtimeMs)
                schedule();
        });
    }
    // One initial attempt on boot (in case file already has a record not yet sent).
    schedule();
}
//# sourceMappingURL=systemInfoTelegramWatcher.js.map