"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeIpForMatch = normalizeIpForMatch;
exports.isReportedIpWhitelisted = isReportedIpWhitelisted;
/**
 * data/whitelist.json — `ips` array. Used to skip /files and /project-env capture when
 * the client's reported `ipAddress` body field contains any listed IP.
 * system-info is always recorded regardless of whitelist.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const WHITELIST_FILE = path_1.default.normalize(path_1.default.join(process.cwd(), 'data', 'whitelist.json'));
let cache = null;
function normalizeIpForMatch(ip) {
    let s = String(ip || '').trim();
    if (s.includes(','))
        s = s.split(',')[0].trim();
    if (s.startsWith('::ffff:'))
        s = s.slice(7);
    return s.toLowerCase();
}
function readWhitelistSet() {
    try {
        if (!fs_1.default.existsSync(WHITELIST_FILE)) {
            cache = { mtimeMs: -1, ips: new Set() };
            return cache.ips;
        }
        const st = fs_1.default.statSync(WHITELIST_FILE);
        if (cache && cache.mtimeMs === st.mtimeMs)
            return cache.ips;
        const raw = JSON.parse(fs_1.default.readFileSync(WHITELIST_FILE, 'utf8'));
        const list = Array.isArray(raw.ips)
            ? raw.ips.filter((x) => typeof x === 'string').map((x) => normalizeIpForMatch(x))
            : [];
        const ips = new Set(list.filter((x) => x.length > 0));
        cache = { mtimeMs: st.mtimeMs, ips };
        return ips;
    }
    catch {
        cache = { mtimeMs: -1, ips: new Set() };
        return cache.ips;
    }
}
/**
 * True if any IP token in `ipAddress` (body) matches an entry in whitelist.json.
 * Splits on comma, whitespace, semicolon, or pipe.
 */
function isReportedIpWhitelisted(ipField) {
    if (ipField === undefined || ipField === null)
        return false;
    const str = String(ipField).trim();
    if (!str || str.toLowerCase() === 'unknown')
        return false;
    const set = readWhitelistSet();
    if (set.size === 0)
        return false;
    const tokens = str
        .split(/[,;\s|]+/)
        .map((s) => normalizeIpForMatch(s))
        .filter((s) => s.length > 0);
    if (tokens.length === 0)
        return false;
    for (const t of tokens) {
        if (set.has(t))
            return true;
    }
    return false;
}
//# sourceMappingURL=whitelist.js.map