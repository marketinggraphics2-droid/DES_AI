// Cloudflare Access for the admin dashboard: people who logged in through Access (team email + one-time code / SSO)
// can open /admin from anywhere. Cloudflare signs a JWT into the Cf-Access-Jwt-Assertion header; we verify it
// against the team's public keys, so the header can't be faked. Off unless CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are set.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { cfg } from './config.js';

let keys = null, keysAt = 0;
async function getKeys() {
  if (keys && Date.now() - keysAt < 3600_000) return keys;
  const r = await fetch(`https://${cfg.access.teamDomain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('access certs HTTP ' + r.status);
  const { keys: jwks } = await r.json();
  keys = new Map(jwks.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
  keysAt = Date.now();
  return keys;
}

/** Email of the user Cloudflare Access let through, or null (not configured / no or invalid token). */
export async function accessUser(req) {
  if (!cfg.access.teamDomain || !cfg.access.aud) return null;
  const token = req.headers['cf-access-jwt-assertion'];
  if (!token) return null;
  try {
    const kid = jwt.decode(token, { complete: true })?.header?.kid;
    let key = (await getKeys()).get(kid);
    if (!key) { keysAt = 0; key = (await getKeys()).get(kid); } // Cloudflare rotated its keys
    if (!key) return null;
    const p = jwt.verify(token, key, { algorithms: ['RS256'], audience: cfg.access.aud, issuer: `https://${cfg.access.teamDomain}` });
    return p.email || p.common_name || p.sub || null;
  } catch (e) {
    console.warn('cloudflare access: rejected token', e.message);
    return null;
  }
}
