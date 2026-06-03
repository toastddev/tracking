import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import type { FacebookGrantPayload } from '../types/facebookAds';

// Separate secret + audience from the GAds JWT helpers so a leaked Meta JWT
// can't be redeemed as a Google grant (and vice versa). Functional shape
// mirrors ../utils/googleAdsState.ts exactly.

const ISSUER = 'tracking-backend';
const AUDIENCE_STATE = 'facebook-oauth';
const AUDIENCE_GRANT = 'facebook-grant';
const TTL_SECONDS = 60 * 10;
const GRANT_TTL_SECONDS = 60 * 15;

function secretKey(): Uint8Array {
  const s = process.env.META_OAUTH_STATE_SECRET;
  if (!s || s.length < 16) {
    throw new Error('META_OAUTH_STATE_SECRET is not configured (must be >= 16 chars)');
  }
  return new TextEncoder().encode(s);
}

export interface FbOauthStatePayload {
  admin_email: string;
  type: 'business' | 'ad_account';
  nonce: string;
}

export async function signFbOauthState(
  payload: Omit<FbOauthStatePayload, 'nonce'>
): Promise<string> {
  const nonce = randomBytes(16).toString('base64url');
  return await new SignJWT({ ...payload, nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_STATE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + TTL_SECONDS)
    .sign(secretKey());
}

export async function verifyFbOauthState(token: string): Promise<FbOauthStatePayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE_STATE,
    });
    if (
      typeof payload.admin_email !== 'string' ||
      (payload.type !== 'business' && payload.type !== 'ad_account') ||
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

export async function signFbGrantToken(payload: FacebookGrantPayload): Promise<string> {
  return await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_GRANT)
    .setExpirationTime(Math.floor(Date.now() / 1000) + GRANT_TTL_SECONDS)
    .sign(secretKey());
}

export async function verifyFbGrantToken(token: string): Promise<FacebookGrantPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE_GRANT,
    });
    if (
      typeof payload.meta_user_email !== 'string' ||
      (payload.type !== 'business' && payload.type !== 'ad_account') ||
      !payload.access_token_enc ||
      typeof (payload.access_token_enc as { ciphertext?: unknown }).ciphertext !== 'string'
    ) return null;
    return {
      access_token_enc: payload.access_token_enc as FacebookGrantPayload['access_token_enc'],
      access_token_expires_at:
        typeof payload.access_token_expires_at === 'string'
          ? payload.access_token_expires_at
          : undefined,
      meta_user_email: payload.meta_user_email,
      scopes: Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [],
      type: payload.type,
    };
  } catch {
    return null;
  }
}
