"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDatabase = connectDatabase;
exports.disconnectDatabase = disconnectDatabase;
const mongoose_1 = __importDefault(require("mongoose"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubblemap-bypass';
async function connectDatabase() {
    try {
        await mongoose_1.default.connect(MONGODB_URI);
        console.log('✅ MongoDB connected');
    }
    catch (error) {
        console.error('❌ MongoDB connection error:', error);
        throw error;
    }
}
async function disconnectDatabase() {
    try {
        await mongoose_1.default.disconnect();
        console.log('✅ MongoDB disconnected');
    }
    catch (error) {
        console.error('❌ MongoDB disconnection error:', error);
        throw error;
    }
}
//# sourceMappingURL=database.js.map