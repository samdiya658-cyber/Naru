import pg from 'pg';
import { createHandler } from '../server/index.mjs';
import { providerFromEnv } from '../server/providers.mjs';

let pool;
let handler;

function getPool() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  if (!pool) {
    const isCloudPg = dbUrl.includes('supabase.co') || dbUrl.includes('pooler.supabase.com') || dbUrl.includes('neon.tech') || dbUrl.includes('sslmode=require');
    pool = new pg.Pool({
      connectionString: dbUrl,
      ssl: isCloudPg ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

export default async function (req, res) {
  try {
    // CORS support
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Determine original request path
    const originalUrl = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.url;
    if (originalUrl && originalUrl.startsWith('/api/')) {
      req.url = originalUrl;
    }

    const db = getPool();
    if (!db) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'DATABASE_URL is not set in Vercel. Please add your Supabase connection string in Vercel Project Settings -> Environment Variables.'
      }));
    }

    if (!handler) {
      const provider = providerFromEnv();
      handler = createHandler({
        pool: db,
        provider,
        opts: { secure: true }
      });
    }

    return await handler(req, res);
  } catch (err) {
    console.error('Vercel API error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Server error' }));
    } else {
      res.end();
    }
  }
}
