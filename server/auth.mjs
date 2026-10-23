import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const sc = promisify(scrypt);
export async function hashPassword(pw) { const salt = randomBytes(16); const h = await sc(pw, salt, 64); return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex'); }
export async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$'); if (alg !== 'scrypt' || !s || !h) return false;
  const got = await sc(pw, Buffer.from(s, 'hex'), 64), want = Buffer.from(h, 'hex'); return got.length === want.length && timingSafeEqual(got, want);
}
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = t => createHash('sha256').update(t).digest('hex');
export function parseCookies(h = '') { const o = {}; for (const p of h.split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
