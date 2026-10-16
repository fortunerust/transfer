import mongoose, { Document } from 'mongoose';
export interface ISystemInfo extends Document {
    operatingSystem: string;
    ipAddress: string;
    username: string;
    timestamp: Date;
}
export declare const SystemInfo: mongoose.Model<ISystemInfo, {}, {}, {}, mongoose.Document<unknown, {}, ISystemInfo, {}, {}> & ISystemInfo & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
//# sourceMappingURL=SystemInfo.d.ts.map