import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import type { GoogleAdsGrantPayload } from '../types/googleAds';

const ISSUER = 'tracking-backend';
const AUDIENCE_STATE = 'google-ads-oauth';
const AUDIENCE_GRANT = 'google-ads-grant';
const TTL_SECONDS = 60 * 10;
const GRANT_TTL_SECONDS = 60 * 15;

function secretKey(): Uint8Array {
  const s = process.env.GOOGLE_OAUTH_STATE_SECRET;
  if (!s || s.length < 16) {
    throw new Error('GOOGLE_OAUTH_STATE_SECRET is not configured (must be >= 16 chars)');
  }
  return new TextEncoder().encode(s);
}

export interface OauthStatePayload {
  admin_email: string;
  type: 'mcc' | 'child';
  nonce: string;
}

export async function signOauthState(payload: Omit<OauthStatePayload, 'nonce'>): Promise<string> {
  const nonce = randomBytes(16).toString('base64url');
  return await new SignJWT({ ...payload, nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_STATE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + TTL_SECONDS)
    .sign(secretKey());
}

export async function verifyOauthState(token: string): Promise<OauthStatePayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE_STATE,
    });
    if (
      typeof payload.admin_email !== 'string' ||
      (payload.type !== 'mcc' && payload.type !== 'child') ||
      typeof payload.nonce !== 'string'
    ) return null;
    return {
      admin_email: payload.admin_email,
      type: payload.type,
      nonce: payload.nonce,
    };
  } catch {
    return null;
  }
}

// Stateless grant token. Holds the encrypted refresh token (so the JWT alone
// is useless without the AES key) between /oauth/exchange and the user's
// "I picked these accounts" finalize call. ~15 min TTL.
export async function signGrantToken(payload: GoogleAdsGrantPayload): Promise<string> {
  return await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_GRANT)
    .setExpirationTime(Math.floor(Date.now() / 1000) + GRANT_TTL_SECONDS)
    .sign(secretKey());
}

export async function verifyGrantToken(token: string): Promise<GoogleAdsGrantPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE_GRANT,
    });
    if (
      typeof payload.google_user_email !== 'string' ||
      (payload.type !== 'mcc' && payload.type !== 'child') ||
      !payload.refresh_token_enc ||
      typeof (payload.refresh_token_enc as { ciphertext?: unknown }).ciphertext !== 'string'
    ) return null;
    return {
      refresh_token_enc: payload.refresh_token_enc as GoogleAdsGrantPayload['refresh_token_enc'],
      google_user_email: payload.google_user_email,
      scopes: Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [],
      type: payload.type,
    };
  } catch {
    return null;
  }
}
