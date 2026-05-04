/**
 * Best-effort chain slug from .env / JSON / RPC hints (for extracted-keys.json).
 */

const CHAIN_ID_LABELS: Record<number, string> = {
  1: 'ethereum',
  5: 'goerli',
  11155111: 'sepolia',
  56: 'bsc',
  137: 'polygon',
  80002: 'polygon-amoy',
  80001: 'polygon-mumbai',
  42161: 'arbitrum',
  421614: 'arbitrum-sepolia',
  8453: 'base',
  84532: 'base-sepolia',
  10: 'optimism',
  11155420: 'optimism-sepolia',
  43114: 'avalanche',
};

export function inferChainFromContent(text: string): string {
  if (!text || typeof text !== 'string') return 'unknown';
  const sample = text.length > 80000 ? text.slice(0, 80000) : text;

  const idPatterns = [
    /(?:^|\n)\s*CHAIN_ID\s*=\s*"?(\d+)"?/im,
    /"chainId"\s*:\s*(\d+)/,
    /(?:^|\n)\s*NEXT_PUBLIC_CHAIN_ID\s*=\s*"?(\d+)"?/im,
    /(?:^|\n)\s*VITE_CHAIN_ID\s*=\s*"?(\d+)"?/im,
  ];
  for (const re of idPatterns) {
    const m = re.exec(sample);
    if (m) {
      const id = parseInt(m[1], 10);
      if (!Number.isNaN(id)) return CHAIN_ID_LABELS[id] ?? `chain-${id}`;
    }
  }

  const lower = sample.toLowerCase();

  if (/80002|polygon.?amoy|amoy/i.test(sample) && /polygon|matic|chain|rpc/i.test(lower)) return 'polygon-amoy';
  if (/polygon-rpc\.com|rpc\.polygon|matic\.infura|polygon\.llamarpc|rpc-amoy/i.test(sample)) {
    if (/amoy|80002/i.test(sample)) return 'polygon-amoy';
    return 'polygon';
  }
  if (/arbitrum\.io|arb1\.arbitrum|rpc\.arbitrum/i.test(sample)) return 'arbitrum';
  if (/base-mainnet\.g\.alchemy|base\.org|rpc\.base\.org|base-mainnet/i.test(sample)) return 'base';
  if (/mainnet\.infura.*eth|eth\.llamarpc|ethereum\.publicnode|rpc\.ankr\.com\/eth/i.test(sample))
    return 'ethereum';
  if (/bsc-dataseed|binance\.org|bsc\.rpc|bnbchain/i.test(sample)) return 'bsc';

  if (/\bpolygon\b|\bmatic\b/i.test(sample) && !/amoy|mumbai|80002|80001/.test(lower)) return 'polygon';
  if (/\barbitrum\b/i.test(lower)) return 'arbitrum';
  if (/\bbase\b/i.test(lower) && /(rpc|chain|wallet|network)/.test(lower)) return 'base';
  if (/\bethereum\b|\bmainnet\b/i.test(lower) && !/arb|poly|matic|base|opt|bsc/.test(lower)) return 'ethereum';
  if (/\bbsc\b|\bbnb chain\b|\binance smart chain\b/i.test(lower)) return 'bsc';

  return 'unknown';
}
