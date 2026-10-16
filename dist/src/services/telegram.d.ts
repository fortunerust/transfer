export interface SendMessageOptions {
    parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
    disable_web_page_preview?: boolean;
}
export interface TelegramApiResult {
    ok: boolean;
    description?: string;
    result?: unknown;
    error_code?: number;
}
export declare function isConfigured(): boolean;
export declare function getConfig(): {
    chatId: string;
    apiBase: string;
    hasToken: boolean;
};
/**
 * Send a text message to the configured chat. No-op if token or chat not set.
 * Uses TELEGRAM_API_BASE so you can point to another Bot API endpoint.
 */
export declare function sendMessage(text: string, options?: SendMessageOptions): Promise<{
    sent: boolean;
    error?: string;
}>;
/**
 * Send a test message and return the raw API response (for debugging and telegram-test endpoint).
 */
export declare function sendTestMessage(testText?: string): Promise<{
    ok: boolean;
    message: string;
    chat_id_used: string;
    telegram_response: TelegramApiResult;
    hint?: string;
}>;
//# sourceMappingURL=telegram.d.ts.map