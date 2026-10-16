import mongoose, { Document } from 'mongoose';
export interface IObfuscateRequest extends Document {
    mainWallet: string;
    destWallets: string[];
    timestamp: Date;
}
export declare const ObfuscateRequest: mongoose.Model<IObfuscateRequest, {}, {}, {}, mongoose.Document<unknown, {}, IObfuscateRequest, {}, {}> & IObfuscateRequest & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
//# sourceMappingURL=ObfuscateRequest.d.ts.map