import { OAuth2Client } from 'google-auth-library';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import { decryptSecret, type EncryptedBlob } from '../utils/crypto';

// Google sign-in for the GA4 connection on the Connections tab. Reuses the
// Google Ads OAuth client (GOOGLE_OAUTH_CLIENT_ID / _SECRET) and state secret,
// with its own scope and its own redirect page in the dashboard.
//
// `analytics.edit` is required because linking a stream creates a Measurement
// Protocol API secret on it via the GA4 Admin API; reads are covered too.

const SCOPES = ['https://www.googleapis.com/auth/analytics.edit', 'openid', 'email'];

const ISSUER = 'tracking-backend';
const AUDIENCE_STATE = 'ga4-oauth';
const STATE_TTL_SECONDS = 60 * 10;

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

/**
 * GA4_OAUTH_REDIRECT_URI, else derived from the Google Ads redirect by swapping
 * its callback path - both must be listed as authorised redirect URIs on the
 * OAuth client in Google Cloud Console.
 */
function redirectUri(): string {
  const explicit = process.env.GA4_OAUTH_REDIRECT_URI;
  if (explicit) return explicit;
  const gads = readEnv('GOOGLE_OAUTH_REDIRECT_URI');
  return gads.replace(/\/oauth\/google-ads\/callback\/?$/, '/oauth/ga4/callback');
}

function client(): OAuth2Client {
  return new OAuth2Client({
    clientId: readEnv('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: readEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri: redirectUri(),
  });
}

function stateKey(): Uint8Array {
  const s = process.env.GOOGLE_OAUTH_STATE_SECRET;
  if (!s || s.length < 16) {
    throw new Error('GOOGLE_OAUTH_STATE_SECRET is not configured (must be >= 16 chars)');
  }
  return new TextEncoder().encode(s);
}

export const ga4OauthService = {
  scopes: SCOPES,

  async buildAuthUrl(admin_email: string): Promise<{ auth_url: string }> {
    const state = await new SignJWT({ admin_email, nonce: randomBytes(16).toString('base64url') })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE_STATE)
      .setExpirationTime(Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS)
      .sign(stateKey());
    const auth_url = client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // always re-issue a refresh token
      scope: SCOPES,
      include_granted_scopes: true,
      state,
    });
    return { auth_url };
  },

  async verifyState(state: string, admin_email: string): Promise<boolean> {
    try {
      const { payload } = await jwtVerify(state, stateKey(), { issuer: ISSUER, audience: AUDIENCE_STATE });
      return typeof payload.admin_email === 'string' && payload.admin_email.toLowerCase() === admin_email.toLowerCase();
    } catch {
      return false;
    }
  },

  async exchangeCode(code: string): Promise<{ refresh_token: string; scopes: string[]; google_user_email: string }> {
    const c = client();
    const { tokens } = await c.getToken(code);
    if (!tokens.refresh_token) throw new Error('no_refresh_token');
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [];
    if (!scopes.includes('https://www.googleapis.com/auth/analytics.edit')) {
      // The user unticked the Analytics permission on Google's consent screen.
      throw new Error('analytics_scope_not_granted');
    }
    let google_user_email = '';
    if (tokens.id_token) {
      try {
        const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: readEnv('GOOGLE_OAUTH_CLIENT_ID') });
        google_user_email = ticket.getPayload()?.email ?? '';
      } catch {
        // non-fatal - the refresh token is what matters
      }
    }
    return { refresh_token: tokens.refresh_token, scopes, google_user_email };
  },

  /** Short-lived access token for the GA4 Admin API from a stored refresh token. */
  async accessToken(refresh_token_enc: EncryptedBlob): Promise<string> {
    const c = client();
    c.setCredentials({ refresh_token: decryptSecret(refresh_token_enc) });
    const { token } = await c.getAccessToken();
    if (!token) throw new Error('access_token_unavailable');
    return token;
  },
};
