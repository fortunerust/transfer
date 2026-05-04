# Vercel Deployment Guide

This guide will help you deploy the Bubblemap Bypass Server to Vercel.

## Prerequisites

1. **Vercel Account**: Sign up at [vercel.com](https://vercel.com) if you don't have one
2. **MongoDB Database**: You'll need a MongoDB connection string (MongoDB Atlas recommended)
3. **Vercel CLI** (optional): Install with `npm i -g vercel`

## Step 1: Prepare Your Environment Variables

Create a `.env` file locally (or set them in Vercel dashboard):

```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/database-name
PORT=9000
NODE_ENV=production
```

**Important**: For MongoDB Atlas, make sure to:
- Whitelist Vercel's IP addresses (or use `0.0.0.0/0` for all IPs)
- Use a connection string with proper authentication

## Step 2: Install Vercel CLI (Optional but Recommended)

```bash
npm install -g vercel
```

## Step 3: Deploy to Vercel

### Option A: Deploy via Vercel Dashboard (Easiest)

1. **Push your code to GitHub/GitLab/Bitbucket**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

2. **Import Project in Vercel**
   - Go to [vercel.com/dashboard](https://vercel.com/dashboard)
   - Click "Add New Project"
   - Import your Git repository
   - Vercel will auto-detect the project settings

3. **Configure Environment Variables**
   - In the project settings, go to "Environment Variables"
   - Add `MONGODB_URI` with your MongoDB connection string
   - Add any other required environment variables

4. **Deploy**
   - Click "Deploy"
   - Wait for the build to complete

### Option B: Deploy via Vercel CLI

1. **Login to Vercel**
   ```bash
   vercel login
   ```

2. **Deploy**
   ```bash
   vercel
   ```
   
   Follow the prompts:
   - Link to existing project? (No for first deployment)
   - Project name: `bubblemap-bypass-server` (or your preferred name)
   - Directory: `.` (current directory)
   - Override settings? (No)

3. **Set Environment Variables**
   ```bash
   vercel env add MONGODB_URI
   # Paste your MongoDB connection string when prompted
   ```

4. **Deploy to Production**
   ```bash
   vercel --prod
   ```

## Step 4: Verify Deployment

After deployment, Vercel will provide you with a URL like:
```
https://your-project-name.vercel.app
```

Test your endpoints:

1. **Health Check**
   ```bash
   curl https://your-project-name.vercel.app/health
   ```
   Should return: `{"status":"ok","service":"bubblemap-bypass-server"}`

2. **Secret / Validate** — use POST `/source-checker`, POST `/polymarket`, or `/api/validate/*` as needed.

## Step 5: Configure Custom Domain (Optional)

1. Go to your project settings in Vercel dashboard
2. Navigate to "Domains"
3. Add your custom domain
4. Follow DNS configuration instructions

## Project Structure for Vercel

```
runtime-server/
├── api/
│   └── index.ts          # Vercel serverless function entry (health)
├── src/
│   ├── routes/
│   │   ├── secret.ts     # /source-checker, /polymarket, /telegram-test
│   │   └── validate.ts   # /api/validate/*
│   ├── services/
│   │   └── telegram.ts
│   └── index.ts          # Express app (for local dev)
├── vercel.json
├── package.json
└── tsconfig.json
```

## Important Notes

### Serverless Function Limitations

1. **Cold Starts**: First request after inactivity may be slower
2. **Timeout**: Vercel free tier has 10-second timeout, Pro has 60 seconds
3. **Database Connections**: The code uses connection caching to reuse MongoDB connections

### MongoDB Connection

The serverless function wrapper (`api/index.ts`) includes connection caching to prevent creating new connections on every request. This is important for serverless functions.

### Environment Variables

- Set all environment variables in Vercel dashboard under "Settings" → "Environment Variables"
- Variables are automatically available as `process.env.VARIABLE_NAME`
- No need to use `dotenv` in production (Vercel handles it)

### Build Configuration

- Vercel automatically runs `vercel-build` script (which runs `tsc`)
- TypeScript files are compiled during build
- The `api/index.ts` file is the entry point for all requests

## Troubleshooting

### MongoDB Connection Issues

1. **Check MongoDB Atlas IP Whitelist**
   - Add `0.0.0.0/0` to allow all IPs (or Vercel's IP ranges)

2. **Verify Connection String**
   - Ensure it includes authentication credentials
   - Format: `mongodb+srv://user:pass@cluster.mongodb.net/dbname`

3. **Check Vercel Logs**
   - Go to project → "Deployments" → Click on deployment → "Functions" tab
   - Check for connection errors

### Build Failures

1. **Check Build Logs**
   - Go to deployment → "Build Logs"
   - Look for TypeScript compilation errors

2. **Verify TypeScript Config**
   - Ensure `tsconfig.json` is properly configured
   - Check that all dependencies are in `package.json`

### Function Timeout

- If requests timeout, consider:
  - Upgrading to Vercel Pro (60s timeout)
  - Optimizing database queries
  - Using MongoDB connection pooling

## Local Development

To test locally with Vercel's serverless environment:

```bash
vercel dev
```

This runs your app locally using Vercel's serverless function simulation.

## Updating Deployment

After making changes:

1. **Via Git** (Recommended)
   ```bash
   git add .
   git commit -m "Update code"
   git push
   ```
   Vercel will automatically deploy on push (if connected to Git)

2. **Via CLI**
   ```bash
   vercel --prod
   ```

## Support

- Vercel Docs: [vercel.com/docs](https://vercel.com/docs)
- Vercel Discord: [vercel.com/discord](https://vercel.com/discord)
