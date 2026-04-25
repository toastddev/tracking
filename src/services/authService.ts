import { SignJWT, jwtVerify } from 'jose';
import { timingSafeEqual } from 'node:crypto';

const ISSUER = 'tracking-backend';
const AUDIENCE = 'tracking-admin';
const TTL_SECONDS = 60 * 60 * 24; // 24h

function secretKey(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error('JWT_SECRET is not configured (must be >= 16 chars)');
  }
  return new TextEncoder().encode(s);
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  email: string;
}

export const authService = {
  async login(email: string, password: string): Promise<LoginResult | null> {
    const expectedEmail = process.env.ADMIN_EMAIL ?? '';
    const expectedPassword = process.env.ADMIN_PASSWORD ?? '';
    if (!expectedEmail || !expectedPassword) return null;

    if (!constantTimeEqual(email.toLowerCase(), expectedEmail.toLowerCase())) return null;
    if (!constantTimeEqual(password, expectedPassword)) return null;

    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
    const token = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(secretKey());

    return { token, expiresAt: expiresAt.toISOString(), email };
  },

  async verify(token: string): Promise<{ email: string } | null> {
    try {
      const { payload } = await jwtVerify(token, secretKey(), {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const email = typeof payload.email === 'string' ? payload.email : null;
      return email ? { email } : null;
    } catch {
      return null;
    }
  },
};
