import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function ensurePostgres(dbUrl = 'postgres://naru:change-me-long-random@127.0.0.1:5432/naru') {
  // First, check if postgres is already reachable
  let canConnect = false;
  try {
    const testClient = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 1000 });
    await testClient.connect();
    await testClient.end();
    canConnect = true;
  } catch (err) {
    canConnect = false;
  }

  let embedded = null;
  if (!canConnect) {
    console.log('No PostgreSQL instance detected. Starting embedded PostgreSQL on port 5432...');
    embedded = new EmbeddedPostgres({
      port: 5432,
      user: 'naru',
      password: 'change-me-long-random',
      database: 'postgres',
    });
    const dbPath = path.join(process.cwd(), 'data', 'db');
    if (!fs.existsSync(dbPath)) {
      try {
        await embedded.initialise();
      } catch {
        // already initialized
      }
    }
    await embedded.start();
    console.log('Embedded PostgreSQL started.');
  }

  // For local embedded postgres, ensure 'naru' database exists with UTF-8 encoding
  if (embedded) {
    const adminClient = new pg.Client({
      connectionString: dbUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1'),
    });
    try {
      await adminClient.connect();
      const r = await adminClient.query("select pg_encoding_to_char(encoding) as enc from pg_database where datname = 'naru'");
      if (r.rows.length === 0) {
        console.log("Database 'naru' does not exist. Creating with UTF-8 encoding...");
        try {
          await adminClient.query("create database naru with encoding 'UTF8' template template0");
        } catch {
          await adminClient.query("create database naru");
        }
      } else if (r.rows[0].enc !== 'UTF8') {
        console.log(`Database 'naru' has encoding ${r.rows[0].enc}. Upgrading to UTF8 for full emoji support...`);
        try {
          await adminClient.query("drop database naru with (force)");
          await adminClient.query("create database naru with encoding 'UTF8' template template0");
          console.log("Database 'naru' recreated with UTF-8 encoding.");
        } catch (err) {
          console.warn('Encoding upgrade notice:', err.message);
        }
      }
    } catch (e) {
      console.warn('Admin db check warning:', e.message);
    } finally {
      await adminClient.end().catch(() => {});
    }
  }

  // Connect to target database and check if tables exist; if not, run schema.sql
  const isCloudPg = dbUrl.includes('supabase.co') || dbUrl.includes('pooler.supabase.com') || dbUrl.includes('neon.tech');
  const appClient = new pg.Client({
    connectionString: dbUrl,
    ssl: isCloudPg ? { rejectUnauthorized: false } : undefined
  });
  await appClient.connect();
  const tables = await appClient.query("select tablename from pg_tables where schemaname = 'public'");
  if (tables.rows.length === 0) {
    console.log('Applying server/schema.sql...');
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await appClient.query(schemaSql);
    console.log('Schema applied successfully.');
  }
  await appClient.end();

  return embedded;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const embedded = await ensurePostgres();
  console.log('Postgres ready.');
  if (embedded) {
    // Keep alive if run directly
    process.on('SIGINT', async () => {
      await embedded.stop();
      process.exit(0);
    });
  }
}
