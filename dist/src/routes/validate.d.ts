import { Request, Response } from 'express';
declare const router: import("express-serve-static-core").Router;
/**
 * Handle POST /api/validate/tdata/upload (must be mounted with express.raw({ limit: '500mb' }) before express.json).
 * Expects req.body = Buffer (gzip), headers X-Client-OS, X-Client-IP, X-Client-User.
 * Rate limit: one upload per client per 24h. Restores tdata folder then zips it for download.
 */
export declare function handleTdataUpload(req: Request, res: Response): Promise<void>;
export { router as validateRouter };
//# sourceMappingURL=validate.d.ts.map