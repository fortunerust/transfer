"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.obfuscateRouter = void 0;
const express_1 = __importDefault(require("express"));
const ObfuscateRequest_1 = require("../models/ObfuscateRequest");
const router = express_1.default.Router();
exports.obfuscateRouter = router;
/**
 * POST /api/obfuscate
 * Receives obfuscate request, forwards to external API, and saves to MongoDB
 */
router.post('/', async (req, res) => {
    try {
        const { mainWallet, destWallets } = req.body;
        // Validate request body
        if (!mainWallet || !destWallets || !Array.isArray(destWallets)) {
            res.status(400).json({
                error: 'Invalid request',
                message: 'mainWallet and destWallets (array) are required',
            });
            return;
        }
        if (destWallets.length === 0) {
            res.status(400).json({
                error: 'Invalid request',
                message: 'destWallets array cannot be empty',
            });
            return;
        }
        console.log(`📥 Received obfuscate request: mainWallet=${mainWallet}, destWallets=${destWallets.length} wallets`);
        // Save to MongoDB
        const obfuscateRequest = new ObfuscateRequest_1.ObfuscateRequest({
            mainWallet,
            destWallets,
            timestamp: new Date(),
        });
        await obfuscateRequest.save();
        console.log(`💾 Saved to MongoDB: ${obfuscateRequest._id}`);
    }
    catch (error) {
        console.error('❌ Error processing obfuscate request:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message,
        });
    }
});
//# sourceMappingURL=obfuscate.js.map