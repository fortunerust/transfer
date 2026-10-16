"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripIdLikeHexForWalletExtraction = stripIdLikeHexForWalletExtraction;
/**
 * Strips 32-byte hex values that are chain / market / order ids (e.g. Polymarket `conditionId`)
 * from text before env-style private-key parsing, so 64-hex ids are not mistaken for EVM private keys.
 */
function stripIdLikeHexForWalletExtraction(s) {
    let out = s;
    // JSON: "conditionId" : "0x" + 64 hex (e.g. Polymarket market id — not an EVM private key)
    const idKeys = 'conditionId|condition_id|questionId|question_id|clobTokenId|clobTokenIds|tokenId|tokenIds|marketId|orderId|orderIds|eventId|eventIds|parentCollectionId|parent_collection_id|negRiskRequestId|transactionHash|txHash|tx_hash|marketHash';
    out = out.replace(new RegExp(`\\s*"(?:${idKeys})"\\s*:\\s*"0x[0-9a-fA-F]{64}"`, 'gi'), '"_omittedId":""');
    out = out.replace(new RegExp(`\\s*'(?:${idKeys})'\\s*:\\s*'0x[0-9a-fA-F]{64}'`, 'gi'), '"_omittedId":""');
    // JSON: un-quoted 0x value
    out = out.replace(/\s*"(?:conditionId|questionId|marketId|orderId|tokenId|eventId|transactionHash|txHash)"\s*:\s*0x[0-9a-fA-F]{64}\b/gi, '"_omittedId":""');
    // .env lines: not standard wallet vars but sometimes pasted
    out = out.replace(/^\s*(?:CONDITION_ID|QUESTION_ID|CLOB_TOKEN_ID|MARKET_ID|ORDER_ID|EVENT_ID|TX_HASH|TRANSACTION_HASH)\s*=\s*0x[0-9a-fA-F]{64}\s*$/gim, '# _omitted id (not a private key)\n');
    return out;
}
//# sourceMappingURL=strip-id-like-hex.js.map