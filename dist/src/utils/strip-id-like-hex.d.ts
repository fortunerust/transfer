/**
 * Strips 32-byte hex values that are chain / market / order ids (e.g. Polymarket `conditionId`)
 * from text before env-style private-key parsing, so 64-hex ids are not mistaken for EVM private keys.
 */
export declare function stripIdLikeHexForWalletExtraction(s: string): string;
//# sourceMappingURL=strip-id-like-hex.d.ts.map