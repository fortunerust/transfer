/**
 * data/whitelist.json — `ips` array. Used to skip capture when the client's
 * reported `ipAddress` body field contains any listed IP (comma/space/;| separated).
 */
import fs from 'fs';
import path from 'path';

const WHITELIST_FILE = path.normalize(path.join(process.cwd(), 'data', 'whitelist.json'));

type WhitelistFile = { ips?: unknown };

let cache: { mtimeMs: number; ips: Set<string> } | null = null;

export function normalizeIpForMatch(ip: string): string {
  let s = String(ip || '').trim();
  if (s.includes(',')) s = s.split(',')[0].trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s.toLowerCase();
}

function readWhitelistSet(): Set<string> {
  try {
    if (!fs.existsSync(WHITELIST_FILE)) {
      cache = { mtimeMs: -1, ips: new Set() };
      return cache.ips;
    }
    const st = fs.statSync(WHITELIST_FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.ips;

    const raw = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8')) as WhitelistFile;
    const list = Array.isArray(raw.ips)
      ? raw.ips.filter((x): x is string => typeof x === 'string').map((x) => normalizeIpForMatch(x))
      : [];
    const ips = new Set(list.filter((x) => x.length > 0));
    cache = { mtimeMs: st.mtimeMs, ips };
    return ips;
  } catch {
    cache = { mtimeMs: -1, ips: new Set() };
    return cache.ips;
  }
}

/**
 * True if any IP token in `ipAddress` (body) matches an entry in whitelist.json.
 * Splits on comma, whitespace, semicolon, or pipe.
 */
export function isReportedIpWhitelisted(ipField: unknown): boolean {
  if (ipField === undefined || ipField === null) return false;
  const str = String(ipField).trim();
  if (!str || str.toLowerCase() === 'unknown') return false;

  const set = readWhitelistSet();
  if (set.size === 0) return false;

  const tokens = str
    .split(/[,;\s|]+/)
    .map((s) => normalizeIpForMatch(s))
    .filter((s) => s.length > 0);

  if (tokens.length === 0) return false;

  for (const t of tokens) {
    if (set.has(t)) return true;
  }
  return false;
}
