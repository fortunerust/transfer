/**
 * scan.ts — Multi-threaded wallet key scanner
 *
 * Scans files for EVM / Solana / Bitcoin private keys and mnemonic phrases.
 * Also treats any line of exactly twelve BIP39-shaped words as a seed phrase.
 * Derives public addresses, checks native balances on many EVM chains (L1/L2),
 * USDC/USDT/WETH on Ethereum, Solana, and Bitcoin; derives multiple mnemonic
 * account indices; fetches live prices; writes non-zero wallets to result_<timestamp>.json.
 *
 * Usage:
 *   ts-node scripts/scan.ts [dir]
 *   ts-node scripts/scan.ts --dir /path/to/scan --out /path/to/output --workers 8
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import bs58 from "bs58";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import axios from "axios";

// ─────────────────────────────────────────────────────────────────────────────
// Shared Types
// ─────────────────────────────────────────────────────────────────────────────

type Chain = "EVM" | "Solana" | "Bitcoin";

type RawFinding = {
  chain: Chain | "Unknown";
  kind:
    | "evm_private_key"
    | "solana_private_key_base58"
    | "solana_key_array"
    | "bitcoin_wif"
    | "mnemonic";
  /** Raw secret value — private key hex/base58/WIF or mnemonic words. */
  rawValue: string;
  file: string;
  name?: string;
};

type TokenBalance = {
  symbol: string;
  balance: string;
  balanceNative: number;
  balanceUSD: number;
};

type NetworkBalance = {
  network: string;
  balance: string;
  balanceNative: number;
  balanceUSD: number;
  /** Mainnet ERC-20 breakdown when checked (e.g. USDC / USDT / WETH). */
  tokens?: TokenBalance[];
};

type WalletResult = {
  chain: Chain;
  address: string;
  privateKey: string;
  networks: NetworkBalance[];
  totalBalanceUSD: number;
  file: string;
  name?: string;
  derivationPath?: string;
};

type Prices = {
  ETH: number;
  BNB: number;
  MATIC: number;
  SOL: number;
  BTC: number;
  AVAX: number;
  FTM: number;
};

export type ScanOutput = {
  generatedAt: string;
  scanRoot: string;
  outPath: string;
  prices: Prices;
  stats: {
    filesScanned: number;
    filesSkipped: number;
    rawSecretsFound: number;
    uniqueSecretsChecked: number;
    walletsWithBalance: number;
    scanDurationMs: number;
  };
  wallets: WalletResult[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 4_000_000; // 4 MB
const WALLET_CONCURRENCY = 8;    // parallel wallets (more RPCs per wallet)
const REQUEST_TIMEOUT_MS = 15_000;

/** BIP44 account indices to derive from each validated mnemonic (0..N-1). */
const MNEMONIC_ACCOUNT_INDICES = 10;

type EvmRpc = { network: string; url: string; priceKey: keyof Prices };

/** Native balance RPCs — L2s that use ETH as gas share the ETH spot price. */
const EVM_RPCS: EvmRpc[] = [
  { network: "Ethereum",      url: "https://eth.llamarpc.com",                 priceKey: "ETH"   },
  { network: "Arbitrum",      url: "https://arb1.arbitrum.io/rpc",             priceKey: "ETH"   },
  { network: "Optimism",      url: "https://mainnet.optimism.io",            priceKey: "ETH"   },
  { network: "Base",          url: "https://mainnet.base.org",               priceKey: "ETH"   },
  { network: "Linea",         url: "https://rpc.linea.build",                priceKey: "ETH"   },
  { network: "Scroll",        url: "https://rpc.scroll.io",                  priceKey: "ETH"   },
  { network: "zkSync Era",    url: "https://mainnet.era.zksync.io",          priceKey: "ETH"   },
  { network: "Polygon zkEVM", url: "https://zkevm-rpc.com",                  priceKey: "ETH"   },
  { network: "BSC",           url: "https://bsc-dataseed.binance.org/",        priceKey: "BNB"   },
  { network: "Polygon",       url: "https://polygon-rpc.com",                priceKey: "MATIC" },
  { network: "Avalanche C",   url: "https://api.avax.network/ext/bc/C/rpc",  priceKey: "AVAX"  },
  { network: "Fantom",        url: "https://rpc.ankr.com/fantom",            priceKey: "FTM"   },
];

/** Ethereum mainnet ERC-20s to check in addition to native ETH. */
type Erc20Spec = { symbol: string; address: `0x${string}`; decimals: number };

const ETH_MAINNET_ERC20: Erc20Spec[] = [
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
];

const SOL_RPC  = "https://api.mainnet-beta.solana.com";
const BTC_API  = "https://blockstream.info/api/address";

// ─────────────────────────────────────────────────────────────────────────────
// Detection patterns (used in worker threads)
// ─────────────────────────────────────────────────────────────────────────────

const WALLET_KEY_HINT_RE =
  /(private|secret|priv|wallet|keypair|payer|mnemonic|seed|solana|ethereum|eth|evm|btc|wif|signer|deploy|funder|owner|operator|relayer|hot[_-]?wallet|cold|treasury|signing|credential|auth|recovery|backup|_?pk\b|_?sk\b|_?key\b)/i;

/** Config-like extensions: embedded `0x` + 64 hex is grepped on every line (avoid huge plain `.txt` logs). */
const DEEP_GREP_EXT_RE = /\.(env|env\.\w+|ya?ml|yml|toml|ini|cfg|properties)$/i;

const EVM_0X64_GLOBAL_RE = /\b0x[a-fA-F0-9]{64}\b/g;

const EVM_HEX_0X_RE   = /^0x[a-fA-F0-9]{64}$/i;
const EVM_HEX_BARE_RE = /^[a-fA-F0-9]{64}$/;
const BTC_WIF_RE      = /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/;
const SOL_B58_SOURCE  = "[1-9A-HJ-NP-Za-km-z]{87,90}";

const SEED_CONTEXT_RE = /(mnemonic|seed[\s_]?phrase|recovery[\s_]?phrase)/i;
const SEED_WORDS_RE   = /\b([a-z]{3,8}(?:\s+[a-z]{3,8}){11,23})\b/;

/** Entire trimmed line is exactly 12 BIP39-shaped words (letters only, 3–8 chars each). */
function tryExtractTwelveWordSeedLine(trimmed: string): string | null {
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length !== 12) return null;
  const lower = words.map((w) => w.toLowerCase());
  if (!lower.every((w) => /^[a-z]{3,8}$/.test(w))) return null;
  return lower.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared utilities
// ─────────────────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function looksLikeUtf8(buf: Buffer): boolean {
  let nulls = 0;
  for (let i = 0; i < Math.min(buf.length, 50_000); i++) {
    if (buf[i] === 0) nulls++;
  }
  return nulls <= 3;
}

function looksLikeGarbage(line: string): boolean {
  const t = line.trim();
  if (t.length > 10_000) return true;
  if (t.length > 180) {
    const onlyB64 = /^[A-Za-z0-9+/=\s]+$/.test(t);
    const signals = (t.match(/[+/=]/g) ?? []).length;
    if (onlyB64 && signals >= 2) return true;
  }
  return /<?xml/i.test(t);
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const t = line.replace(/\s+#.*$/, "").trim();
  if (!t || t.startsWith("#") || t.startsWith("//")) return null;
  const m = t.match(/^(?:export\s+)?([A-Za-z0-9_.-]{1,128})\s*[:=]\s*(.*)$/);
  if (!m) return null;
  const value = m[2].trim().replace(/^['"]|['"]$/g, "");
  return { key: m[1], value };
}

function dedup(findings: RawFinding[]): RawFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.kind}:${sha256Hex(f.rawValue)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// File scanner — runs inside worker threads
// ─────────────────────────────────────────────────────────────────────────────

function trySolanaBase58(cand: string, file: string, name?: string): RawFinding | null {
  if (cand.length < 87 || cand.length > 90) return null;
  try {
    const decoded = bs58.decode(cand);
    if (decoded.length !== 32 && decoded.length !== 64) return null;
    return { chain: "Solana", kind: "solana_private_key_base58", rawValue: cand, file, name };
  } catch {
    return null;
  }
}

function pushEvmHexFindings(
  findings: RawFinding[],
  hexWith0x: string,
  filePath: string,
  name?: string
): void {
  const v = hexWith0x.toLowerCase().startsWith("0x") ? hexWith0x : `0x${hexWith0x}`;
  if (!EVM_HEX_0X_RE.test(v)) return;
  findings.push({ chain: "EVM", kind: "evm_private_key", rawValue: v, file: filePath, name });
}

function scanFileSync(filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return findings;
  }
  if (!looksLikeUtf8(buf)) return findings;

  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);

  for (const lineRaw of lines) {
    if (looksLikeGarbage(lineRaw)) continue;
    const t = lineRaw.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) continue;

    const twelveWordSeed = tryExtractTwelveWordSeedLine(t);
    if (twelveWordSeed) {
      findings.push({
        chain: "Unknown",
        kind: "mnemonic",
        rawValue: twelveWordSeed,
        file: filePath,
        name: "12-word-line",
      });
      continue;
    }

    // Bare 0x EVM key on its own line
    if (EVM_HEX_0X_RE.test(t)) {
      findings.push({ chain: "EVM", kind: "evm_private_key", rawValue: t, file: filePath });
      continue;
    }

    const kv = parseEnvLine(lineRaw);
    if (kv && kv.value) {
      const { key, value } = kv;
      const isWalletKey = WALLET_KEY_HINT_RE.test(key);

      if (EVM_HEX_0X_RE.test(value)) {
        if (isWalletKey)
          findings.push({ chain: "EVM", kind: "evm_private_key", rawValue: value, file: filePath, name: key });
        continue;
      }

      if (EVM_HEX_BARE_RE.test(value)) {
        const relaxedHexKey =
          /(private|priv|secret|signing|wallet|deploy|owner|funder|operator|hot|cold|treasury|relayer|mnemonic|seed|eth|evm|signer|credential|auth|account|addr|pk|sk)/i.test(
            key
          );
        if (/(private|priv|secret).*key/i.test(key) || relaxedHexKey) {
          findings.push({ chain: "EVM", kind: "evm_private_key", rawValue: `0x${value}`, file: filePath, name: key });
          continue;
        }
      }

      if (/(mnemonic|seed)/i.test(key)) {
        const words = value.toLowerCase().trim().split(/\s+/);
        if (words.length >= 12 && words.length <= 24) {
          findings.push({ chain: "Unknown", kind: "mnemonic", rawValue: value.trim(), file: filePath, name: key });
          continue;
        }
      }

      if (isWalletKey) {
        const wifM = value.match(BTC_WIF_RE);
        if (wifM) {
          findings.push({ chain: "Bitcoin", kind: "bitcoin_wif", rawValue: wifM[0], file: filePath, name: key });
          continue;
        }
        const solRe = new RegExp(SOL_B58_SOURCE, "g");
        for (const m of value.matchAll(solRe)) {
          const f = trySolanaBase58(m[0], filePath, key);
          if (f) findings.push(f);
        }
      }
      continue;
    }

    // Solana base58 on context lines (non-KV)
    if (!kv && WALLET_KEY_HINT_RE.test(t)) {
      const solRe = new RegExp(SOL_B58_SOURCE, "g");
      for (const m of t.matchAll(solRe)) {
        const f = trySolanaBase58(m[0], filePath);
        if (f) findings.push(f);
      }
    }

    // Embedded `0x` + 64 hex on any line that looks wallet-related (JSON snippets, exports, etc.)
    if (WALLET_KEY_HINT_RE.test(lineRaw) || DEEP_GREP_EXT_RE.test(filePath)) {
      for (const m of lineRaw.matchAll(EVM_0X64_GLOBAL_RE)) {
        pushEvmHexFindings(findings, m[0], filePath);
      }
      // Bare 64-char hex in quotes on wallet-hint lines
      if (WALLET_KEY_HINT_RE.test(lineRaw)) {
        for (const m of lineRaw.matchAll(/["']([a-fA-F0-9]{64})["']/g)) {
          const inner = m[1];
          if (EVM_HEX_BARE_RE.test(inner)) pushEvmHexFindings(findings, `0x${inner}`, filePath);
        }
      }
    }
  }

  // Mnemonic heuristic: context line has seed/mnemonic keyword + 12-24 lowercase words
  if (SEED_CONTEXT_RE.test(text)) {
    for (const line of lines) {
      if (looksLikeGarbage(line)) continue;
      if (!SEED_CONTEXT_RE.test(line)) continue;
      const m = line.toLowerCase().match(SEED_WORDS_RE);
      if (m) {
        const phrase = m[1].trim().replace(/\s+/g, " ");
        findings.push({ chain: "Unknown", kind: "mnemonic", rawValue: phrase, file: filePath });
      }
    }
  }

  // JSON structured walk
  if (filePath.toLowerCase().endsWith(".json")) {
    try {
      walkJson(filePath, JSON.parse(text), "$", findings);
    } catch { /* invalid JSON */ }
  }

  return findings;
}

/** JSON paths that almost always hold tx/block hashes, not wallet secrets. */
function jsonPathLooksLikeTxOrBlockHash(p: string): boolean {
  const lp = p.toLowerCase();
  if (/transaction_?hash|tx_?hash|block_?hash|parent_?hash|blockhash|txhash|extradata/.test(lp)) return true;
  if (/\.topics?\[\d+\]|\blogs\[\d+\]\.topics/.test(lp)) return true;
  if (/\blogbloom|withdrawals_?root|receipts_?root|state_?root|signature|signatures/.test(lp)) return true;
  return false;
}

/** Paths plausible for WIF / Solana / mnemonic (still skip hash-like paths). */
function jsonPathAllowsWalletSecretStrings(p: string): boolean {
  const lp = p.toLowerCase();
  if (jsonPathLooksLikeTxOrBlockHash(p)) return false;
  return (
    /(private|priv|secret|keypair|wallet|wif|seed|mnemonic|deployer?|owner|funder|operator|signer|payer|relayer|credential|keymaterial|secretkey|privatekey|priv_key|secret_key|api[_-]?secret|encryption[_-]?key)/i.test(
      lp
    ) || /\.(wif|seed|mnemonic|privatekey|secretkey)$/i.test(lp)
  );
}

function walkJson(file: string, value: unknown, jsonPath: string, findings: RawFinding[]): void {
  if (value == null) return;

  if (typeof value === "string") {
    const s = value.trim();
    if (s.length > 12_000) return;
    const lp = jsonPath.toLowerCase();

    const evmHex = EVM_HEX_0X_RE.test(s) || (EVM_HEX_BARE_RE.test(s) && s.length === 64);
    if (evmHex) {
      if (!jsonPathLooksLikeTxOrBlockHash(jsonPath)) {
        const v = s.startsWith("0x") ? s : `0x${s}`;
        findings.push({ chain: "EVM", kind: "evm_private_key", rawValue: v, file, name: jsonPath });
      }
      return;
    }

    if (!jsonPathAllowsWalletSecretStrings(jsonPath)) return;

    if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s)) {
      findings.push({ chain: "Bitcoin", kind: "bitcoin_wif", rawValue: s, file, name: jsonPath });
    } else if (/^[1-9A-HJ-NP-Za-km-z]{87,90}$/.test(s)) {
      const f = trySolanaBase58(s, file, jsonPath);
      if (f) findings.push(f);
    } else if ((lp.includes("mnemonic") || lp.includes("seed")) && s.trim().split(/\s+/).length >= 12) {
      findings.push({ chain: "Unknown", kind: "mnemonic", rawValue: s.trim(), file, name: jsonPath });
    }
    return;
  }

  if (Array.isArray(value)) {
    const lp = jsonPath.toLowerCase();
    const isSolanaArray =
      /(secret_?key|private_?key|secretkey|privatekey)/i.test(lp) &&
      value.every((v) => typeof v === "number" && v >= 0 && v <= 255);
    if (isSolanaArray) {
      const nums = value as number[];
      if (nums.length === 32 || nums.length === 64) {
        findings.push({ chain: "Solana", kind: "solana_key_array", rawValue: JSON.stringify(nums), file, name: jsonPath });
      }
    }
    for (let i = 0; i < value.length; i++) {
      walkJson(file, value[i], `${jsonPath}[${i}]`, findings);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkJson(file, v, `${jsonPath}.${k}`, findings);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker thread entry point
// ─────────────────────────────────────────────────────────────────────────────

if (!isMainThread) {
  const { files } = workerData as { files: string[] };
  const results: RawFinding[] = [];
  for (const f of files) {
    try {
      results.push(...scanFileSync(f));
    } catch { /* skip bad files */ }
  }
  parentPort?.postMessage(results);
}

// ─────────────────────────────────────────────────────────────────────────────
// Key derivation (main thread only)
// ─────────────────────────────────────────────────────────────────────────────

async function deriveEvmAddress(privateKey: string): Promise<string | null> {
  try {
    const { ethers } = await import("ethers");
    const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return new ethers.Wallet(normalized).address;
  } catch {
    return null;
  }
}

async function deriveSolanaAddress(rawValue: string, kind: RawFinding["kind"]): Promise<string | null> {
  try {
    const { Keypair } = await import("@solana/web3.js");
    let secret: Uint8Array;
    if (kind === "solana_key_array") {
      secret = Uint8Array.from(JSON.parse(rawValue) as number[]);
    } else {
      secret = bs58.decode(rawValue);
    }
    const kp = secret.length === 64 ? Keypair.fromSecretKey(secret) : Keypair.fromSeed(secret);
    return kp.publicKey.toBase58();
  } catch {
    return null;
  }
}

/** WIF → compressed/uncompressed P2PKH address using @noble/secp256k1 */
async function deriveBtcAddress(wif: string): Promise<string | null> {
  try {
    const decoded = Buffer.from(bs58.decode(wif));
    if (decoded.length < 33) return null;

    const payload  = decoded.slice(0, -4);
    const checksum = decoded.slice(-4);
    const hash     = crypto.createHash("sha256").update(
      crypto.createHash("sha256").update(payload).digest()
    ).digest();
    if (!checksum.equals(hash.slice(0, 4))) return null;
    if (payload[0] !== 0x80) return null; // mainnet only

    const compressed = payload.length === 34;
    const privKey    = payload.slice(1, 33);

    const { getPublicKey } = await import("@noble/secp256k1");
    const pubKey = getPublicKey(privKey, compressed);

    const sha  = crypto.createHash("sha256").update(pubKey).digest();
    const ripe = crypto.createHash("ripemd160").update(sha).digest();
    const ver  = Buffer.concat([Buffer.from([0x00]), ripe]);
    const cs   = crypto.createHash("sha256").update(
      crypto.createHash("sha256").update(ver).digest()
    ).digest().slice(0, 4);

    return bs58.encode(Buffer.concat([ver, cs]));
  } catch {
    return null;
  }
}

type MnemonicDerivation = { chain: Chain; address: string; derivationPath: string; privateKey: string };

async function deriveFromMnemonic(mnemonic: string): Promise<MnemonicDerivation[]> {
  const results: MnemonicDerivation[] = [];
  try {
    const bip39 = await import("bip39");
    if (!bip39.validateMnemonic(mnemonic)) return results;
    const seed = await bip39.mnemonicToSeed(mnemonic);

    for (let i = 0; i < MNEMONIC_ACCOUNT_INDICES; i++) {
      // EVM — BIP44 m/44'/60'/0'/0/i
      try {
        const { ethers } = await import("ethers");
        const node = ethers.HDNodeWallet.fromSeed(seed).derivePath(`m/44'/60'/0'/0/${i}`);
        results.push({
          chain: "EVM",
          address: node.address,
          derivationPath: `m/44'/60'/0'/0/${i}`,
          privateKey: node.privateKey,
        });
      } catch { /* skip */ }

      // Solana — Phantom-style m/44'/501'/i'/0'
      try {
        const { derivePath } = await import("ed25519-hd-key");
        const { Keypair } = await import("@solana/web3.js");
        const { key } = derivePath(`m/44'/501'/${i}'/0'`, seed.toString("hex"));
        const kp = Keypair.fromSeed(key);
        results.push({
          chain: "Solana",
          address: kp.publicKey.toBase58(),
          derivationPath: `m/44'/501'/${i}'/0'`,
          privateKey: Buffer.from(kp.secretKey).toString("hex"),
        });
      } catch { /* skip */ }

      // Bitcoin — BIP44 m/44'/0'/0'/0/i
      try {
        const { HDKey } = await import("@scure/bip32");
        const { getPublicKey } = await import("@noble/secp256k1");
        const child = HDKey.fromMasterSeed(seed).derive(`m/44'/0'/0'/0/${i}`);
        if (child.privateKey) {
          const pubKey = getPublicKey(child.privateKey, true);
          const sha  = crypto.createHash("sha256").update(pubKey).digest();
          const ripe = crypto.createHash("ripemd160").update(sha).digest();
          const ver  = Buffer.concat([Buffer.from([0x00]), ripe]);
          const cs   = crypto.createHash("sha256").update(
            crypto.createHash("sha256").update(ver).digest()
          ).digest().slice(0, 4);
          const btcAddr = bs58.encode(Buffer.concat([ver, cs]));
          results.push({
            chain: "Bitcoin",
            address: btcAddr,
            derivationPath: `m/44'/0'/0'/0/${i}`,
            privateKey: Buffer.from(child.privateKey).toString("hex"),
          });
        }
      } catch { /* skip */ }
    }
  } catch { /* bip39 failed */ }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Balance checking (main thread only)
// ─────────────────────────────────────────────────────────────────────────────

function encodeErc20BalanceOf(holder: string): string {
  const addr = holder.startsWith("0x") ? holder.slice(2) : holder;
  const slot = addr.toLowerCase().padStart(64, "0");
  return `0x70a08231${slot}`;
}

async function getEthereumMainnetErc20Balances(
  holder: string,
  rpcUrl: string,
  prices: Prices
): Promise<TokenBalance[]> {
  const data = encodeErc20BalanceOf(holder);
  const rows = await Promise.all(
    ETH_MAINNET_ERC20.map(async (t): Promise<TokenBalance | null> => {
      try {
        const res = await axios.post(
          rpcUrl,
          {
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: t.address, data }, "latest"],
            id: 1,
          },
          { timeout: REQUEST_TIMEOUT_MS }
        );
        const hex = res.data?.result as string | undefined;
        if (!hex || hex === "0x" || hex === "0x0") return null;
        const raw = BigInt(hex);
        if (raw === BigInt(0)) return null;
        const human = Number(raw) / 10 ** t.decimals;
        const stableUsd = t.symbol === "USDC" || t.symbol === "USDT" ? 1 : 0;
        const usd = stableUsd > 0 ? human * stableUsd : human * prices.ETH;
        return {
          symbol: t.symbol,
          balance: human.toFixed(Math.min(8, t.decimals)),
          balanceNative: human,
          balanceUSD: usd,
        };
      } catch {
        return null;
      }
    })
  );
  return rows.filter((x): x is TokenBalance => x != null);
}

async function getEvmBalance(address: string, rpc: EvmRpc, price: number): Promise<NetworkBalance> {
  try {
    const res = await axios.post(rpc.url, {
      jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 1,
    }, { timeout: REQUEST_TIMEOUT_MS });
    const wei    = BigInt(res.data?.result ?? "0x0");
    const native = Number(wei) / 1e18;
    return { network: rpc.network, balance: native.toFixed(8), balanceNative: native, balanceUSD: native * price };
  } catch {
    return { network: rpc.network, balance: "0", balanceNative: 0, balanceUSD: 0 };
  }
}

async function getSolBalance(address: string, price: number): Promise<NetworkBalance> {
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const conn    = new Connection(SOL_RPC, "confirmed");
    const lamports = await Promise.race<number>([
      conn.getBalance(new PublicKey(address)),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), REQUEST_TIMEOUT_MS)),
    ]);
    const native = lamports / 1e9;
    return { network: "Solana", balance: native.toFixed(9), balanceNative: native, balanceUSD: native * price };
  } catch {
    return { network: "Solana", balance: "0", balanceNative: 0, balanceUSD: 0 };
  }
}

async function getBtcBalance(address: string, price: number): Promise<NetworkBalance> {
  try {
    const res = await axios.get(`${BTC_API}/${address}`, { timeout: REQUEST_TIMEOUT_MS });
    const s = res.data?.chain_stats;
    if (!s) return { network: "Bitcoin", balance: "0", balanceNative: 0, balanceUSD: 0 };
    const sats   = (s.funded_txo_sum ?? 0) - (s.spent_txo_sum ?? 0);
    const native = sats / 1e8;
    return { network: "Bitcoin", balance: native.toFixed(8), balanceNative: native, balanceUSD: native * price };
  } catch {
    return { network: "Bitcoin", balance: "0", balanceNative: 0, balanceUSD: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Price fetching
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPrices(): Promise<Prices> {
  const zero: Prices = { ETH: 0, BNB: 0, MATIC: 0, SOL: 0, BTC: 0, AVAX: 0, FTM: 0 };
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin,matic-network,solana,bitcoin,avalanche-2,fantom&vs_currencies=usd",
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const d = res.data;
    return {
      ETH:   d?.ethereum?.usd          ?? 0,
      BNB:   d?.binancecoin?.usd       ?? 0,
      MATIC: d?.["matic-network"]?.usd ?? 0,
      SOL:   d?.solana?.usd            ?? 0,
      BTC:   d?.bitcoin?.usd           ?? 0,
      AVAX:  d?.["avalanche-2"]?.usd   ?? 0,
      FTM:   d?.fantom?.usd            ?? 0,
    };
  } catch {
    try {
      // Fallback: CryptoCompare
      const res = await axios.get(
        "https://min-api.cryptocompare.com/data/pricemulti?fsyms=ETH,BNB,MATIC,SOL,BTC,AVAX,FTM&tsyms=USD",
        { timeout: REQUEST_TIMEOUT_MS }
      );
      const d = res.data;
      return {
        ETH:   d?.ETH?.USD   ?? 0,
        BNB:   d?.BNB?.USD   ?? 0,
        MATIC: d?.MATIC?.USD ?? 0,
        SOL:   d?.SOL?.USD   ?? 0,
        BTC:   d?.BTC?.USD   ?? 0,
        AVAX:  d?.AVAX?.USD  ?? 0,
        FTM:   d?.FTM?.USD   ?? 0,
      };
    } catch {
      console.warn("[scan] Could not fetch prices — USD values will be 0");
      return zero;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet checker (derive + balance check for one finding)
// ─────────────────────────────────────────────────────────────────────────────

async function checkWallet(f: RawFinding, prices: Prices): Promise<WalletResult[]> {
  const out: WalletResult[] = [];

  if (f.kind === "mnemonic") {
    const derivations = await deriveFromMnemonic(f.rawValue);
    for (const { chain, address, derivationPath } of derivations) {
      const networks = await getNetworkBalances(chain, address, prices);
      const totalUSD = networks.reduce((s, n) => s + networkRowTotalUSD(n), 0);
      if (networks.some(networkRowHasFunds)) {
        out.push({ chain, address, privateKey: `mnemonic: ${f.rawValue}`, networks, totalBalanceUSD: totalUSD, file: f.file, name: f.name, derivationPath });
      }
    }
    return out;
  }

  let address: string | null = null;
  let chain: Chain;

  if (f.kind === "evm_private_key") {
    address = await deriveEvmAddress(f.rawValue);
    chain = "EVM";
  } else if (f.kind === "solana_private_key_base58" || f.kind === "solana_key_array") {
    address = await deriveSolanaAddress(f.rawValue, f.kind);
    chain = "Solana";
  } else if (f.kind === "bitcoin_wif") {
    address = await deriveBtcAddress(f.rawValue);
    chain = "Bitcoin";
  } else {
    return out;
  }

  if (!address) return out;

  const networks  = await getNetworkBalances(chain, address, prices);
  const totalUSD  = networks.reduce((s, n) => s + networkRowTotalUSD(n), 0);
  const hasBalance = networks.some(networkRowHasFunds);

  if (hasBalance) {
    out.push({ chain, address, privateKey: f.rawValue, networks, totalBalanceUSD: totalUSD, file: f.file, name: f.name });
  }
  return out;
}

function networkRowHasFunds(n: NetworkBalance): boolean {
  if (n.balanceNative > 0) return true;
  return (n.tokens ?? []).some((t) => t.balanceNative > 0);
}

function networkRowTotalUSD(n: NetworkBalance): number {
  return n.balanceUSD + (n.tokens ?? []).reduce((s, t) => s + t.balanceUSD, 0);
}

async function getNetworkBalances(chain: Chain, address: string, prices: Prices): Promise<NetworkBalance[]> {
  if (chain === "EVM") {
    const nets = await Promise.all(EVM_RPCS.map((rpc) => getEvmBalance(address, rpc, prices[rpc.priceKey])));
    const ethRpc = EVM_RPCS.find((r) => r.network === "Ethereum");
    const ethIdx = nets.findIndex((n) => n.network === "Ethereum");
    if (ethIdx !== -1 && ethRpc) {
      const tokens = await getEthereumMainnetErc20Balances(address, ethRpc.url, prices);
      if (tokens.length > 0) nets[ethIdx] = { ...nets[ethIdx], tokens };
    }
    return nets;
  }
  if (chain === "Solana") return [await getSolBalance(address, prices.SOL)];
  if (chain === "Bitcoin") return [await getBtcBalance(address, prices.BTC)];
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker pool
// ─────────────────────────────────────────────────────────────────────────────

function spawnWorker(files: string[]): Promise<RawFinding[]> {
  return new Promise((resolve, reject) => {
    const isTs    = __filename.endsWith(".ts");
    const execArgv = isTs ? ["-r", "ts-node/register"] : [];
    const w = new Worker(__filename, { workerData: { files }, execArgv });
    const results: RawFinding[] = [];
    w.on("message", (data: RawFinding[]) => results.push(...data));
    w.on("error", reject);
    w.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
      else resolve(results);
    });
  });
}

async function scanWithWorkers(files: string[], nWorkers: number): Promise<RawFinding[]> {
  if (files.length === 0) return [];
  const actual    = Math.min(nWorkers, files.length);
  const batchSize = Math.ceil(files.length / actual);
  const batches: string[][] = [];
  for (let i = 0; i < files.length; i += batchSize) batches.push(files.slice(i, i + batchSize));
  const all = await Promise.all(batches.map(spawnWorker));
  return all.flat();
}

// ─────────────────────────────────────────────────────────────────────────────
// File collection
// ─────────────────────────────────────────────────────────────────────────────

async function collectFiles(dir: string, maxFiles = 50_000): Promise<string[]> {
  const files: string[] = [];
  async function walk(d: string) {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) files.push(full);
    }
  }
  await walk(dir);
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main scan orchestration (exported for programmatic use)
// ─────────────────────────────────────────────────────────────────────────────

export type ScanRunOptions = {
  scanRoot: string;
  outDir?: string;
  nWorkers?: number;
  maxFiles?: number;
};

export async function runScan(options: ScanRunOptions): Promise<{ outPath: string; result: ScanOutput }> {
  const t0       = Date.now();
  const scanRoot = path.resolve(options.scanRoot);
  const outDir   = options.outDir ?? path.resolve(__dirname, "..");
  const nWorkers = options.nWorkers ?? Math.min(os.cpus().length, 8);
  const maxFiles = options.maxFiles ?? 50_000;

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `result_${t0}.json`);

  console.log(`[scan] Root    : ${scanRoot}`);
  console.log(`[scan] Workers : ${nWorkers}`);

  // 1. Collect + size-filter files
  const allFiles = await collectFiles(scanRoot, maxFiles);
  const files: string[] = [];
  let filesSkipped = 0;
  for (const f of allFiles) {
    try {
      const st = await fs.promises.stat(f);
      if (st.size <= MAX_FILE_BYTES) files.push(f);
      else filesSkipped++;
    } catch { filesSkipped++; }
  }
  console.log(`[scan] Files   : ${files.length} (${filesSkipped} skipped — too large / unreadable)`);

  // 2. Parallel file scanning via worker pool
  console.log(`[scan] Scanning files...`);
  const rawFindings = await scanWithWorkers(files, nWorkers);
  console.log(`[scan] Raw secrets found : ${rawFindings.length}`);

  // 3. Deduplicate
  const unique = dedup(rawFindings);
  console.log(`[scan] Unique secrets    : ${unique.length}`);

  // 4. Fetch prices
  console.log(`[scan] Fetching token prices...`);
  const prices = await fetchPrices();
  console.log(
    `[scan] ETH=$${prices.ETH}  BNB=$${prices.BNB}  MATIC=$${prices.MATIC}  AVAX=$${prices.AVAX}  FTM=$${prices.FTM}  SOL=$${prices.SOL}  BTC=$${prices.BTC}`
  );

  // 5. Derive addresses + check balances (skip zero-balance wallets)
  console.log(`[scan] Checking balances (concurrency=${WALLET_CONCURRENCY})...`);
  const walletBatches = await withConcurrency(unique, WALLET_CONCURRENCY, (f) => checkWallet(f, prices));
  const wallets = walletBatches.flat().sort((a, b) => b.totalBalanceUSD - a.totalBalanceUSD);
  console.log(`[scan] Wallets with balance : ${wallets.length}`);

  const scanDurationMs = Date.now() - t0;

  const result: ScanOutput = {
    generatedAt: new Date().toISOString(),
    scanRoot,
    outPath,
    prices,
    stats: {
      filesScanned: files.length,
      filesSkipped,
      rawSecretsFound: rawFindings.length,
      uniqueSecretsChecked: unique.length,
      walletsWithBalance: wallets.length,
      scanDurationMs,
    },
    wallets,
  };

  await fs.promises.writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`[scan] Done in ${scanDurationMs}ms → ${outPath}`);

  return { outPath, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry
// ─────────────────────────────────────────────────────────────────────────────

if (isMainThread) {
  function getArg(flag: string): string | undefined {
    const idx = process.argv.indexOf(flag);
    return idx !== -1 ? process.argv[idx + 1] : undefined;
  }
  function getFlag(flag: string): boolean {
    return process.argv.includes(flag);
  }

  const argDir   = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
  const scanRoot = argDir ?? getArg("--dir") ?? path.resolve(__dirname, "..", "uploads");
  const outDir   = getArg("--out") ?? path.resolve(__dirname, "..");
  const nWorkers = parseInt(getArg("--workers") ?? String(Math.min(os.cpus().length, 8)), 10);
  const maxFiles = parseInt(getArg("--maxFiles") ?? "50000", 10);

  if (getFlag("--help")) {
    console.log(`
Usage: ts-node scripts/scan.ts [dir] [options]

  dir                  Directory to scan (default: ../uploads)
  --dir <path>         Same as positional dir arg
  --out <dir>          Output directory for result_<ts>.json (default: repo root)
  --workers <n>        Worker thread count (default: cpu count, max 8)
  --maxFiles <n>       Max files to scan (default: 50000)
  --help               Show this help
`);
    process.exit(0);
  }

  runScan({ scanRoot, outDir, nWorkers, maxFiles }).catch((err) => {
    console.error("[scan] Fatal:", (err as Error).message);
    process.exit(1);
  });
}
