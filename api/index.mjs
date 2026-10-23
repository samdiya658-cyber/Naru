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
  // CORS support
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Restore path if rewritten by Vercel
  const pathname = req.url ? new URL(req.url, 'http://x').pathname : '';
  if (!pathname.startsWith('/api/') || pathname === '/api/[...path]') {
    if (req.headers['x-matched-path'] && req.headers['x-matched-path'].startsWith('/api/')) {
      req.url = req.headers['x-matched-path'];
    } else if (req.query?.path) {
      const seg = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path;
      req.url = '/api/' + seg;
    }
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

  return handler(req, res);
}
