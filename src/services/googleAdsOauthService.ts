import { OAuth2Client } from 'google-auth-library';
import { signOauthState, verifyOauthState } from '../utils/googleAdsState';

const SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'openid',
  'email',
];

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

function client(): OAuth2Client {
  return new OAuth2Client({
    clientId: readEnv('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: readEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri: readEnv('GOOGLE_OAUTH_REDIRECT_URI'),
  });
}

export interface ExchangeResult {
  refresh_token: string;
  access_token: string;
  scopes: string[];
  google_user_email: string;
}

export const googleAdsOauthService = {
  scopes: SCOPES,

  async buildAuthUrl(params: { admin_email: string; type: 'mcc' | 'child' }): Promise<{ auth_url: string; state: string }> {
    const state = await signOauthState({ admin_email: params.admin_email, type: params.type });
    const auth_url = client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',                 // force refresh_token re-issue every time
      scope: SCOPES,
      include_granted_scopes: true,
      state,
    });
    return { auth_url, state };
  },

  async verifyState(state: string, admin_email: string) {
    const payload = await verifyOauthState(state);
    if (!payload) return null;
    if (payload.admin_email.toLowerCase() !== admin_email.toLowerCase()) return null;
    return payload;
  },

  // Exchanges the auth code for tokens and pulls the Google account email
  // out of the id_token so we can label the connection in the UI.
  async exchangeCode(code: string): Promise<ExchangeResult> {
    const c = client();
    const { tokens } = await c.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('no_refresh_token');
    }
    let google_user_email = '';
    if (tokens.id_token) {
      try {
        const ticket = await c.verifyIdToken({
          idToken: tokens.id_token,
          audience: readEnv('GOOGLE_OAUTH_CLIENT_ID'),
        });
        const payload = ticket.getPayload();
        google_user_email = payload?.email ?? '';
      } catch {
        // non-fatal — we still have the refresh token
      }
    }
    return {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token ?? '',
      scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : SCOPES,
      google_user_email,
    };
  },
};
