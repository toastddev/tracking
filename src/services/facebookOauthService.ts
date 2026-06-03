import { facebookGraphApi, META, buildGraphUrl } from './facebookGraphClient';
import { signFbOauthState, verifyFbOauthState } from '../utils/facebookOauthState';

// Mirror of ./googleAdsOauthService.ts. Differences:
//   - Meta doesn't issue refresh_tokens. We exchange the short-lived user token
//     immediately for a long-lived (~60d) token and store that.
//   - Scopes are Marketing API scopes, not Adwords.
//   - The auth URL is built by hand (Meta has no first-party Node OAuth lib
//     of the quality of google-auth-library) — same shape, fewer dependencies.

const SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'email',
];

export interface FbExchangeResult {
  access_token_long_lived: string;
  expires_in_seconds: number;        // seconds from now until expiry (Meta's contract)
  expires_at_iso: string;            // absolute, derived for storage
  scopes: string[];
  meta_user_email: string;
}

function buildAuthUrl(state: string): string {
  // Meta's authorize endpoint lives on www.facebook.com, NOT graph.
  // `display=page` forces full-page redirect instead of the popup default.
  const base = (process.env.META_AUTH_BASE_URL || 'https://www.facebook.com').replace(/\/+$/, '');
  const url = new URL(`${base}/${META.apiVersion()}/dialog/oauth`);
  url.searchParams.set('client_id', META.appId());
  url.searchParams.set('redirect_uri', META.redirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('display', 'page');

  // Permissions are delivered one of two ways depending on the app type:
  //
  //  - "Facebook Login for Business" apps (the default for any app created
  //    after the 2024 migration): permissions are bundled into a
  //    Configuration in the App Dashboard. The OAuth URL references that
  //    bundle by config_id. The legacy `scope=` parameter is rejected with
  //    "invalid scope" even for innocent names like `email`.
  //
  //  - Older "Consumer" / pre-migration apps: scope works the legacy way.
  //
  // We auto-pick based on whether META_FB_LOGIN_CONFIG_ID is set. Newly
  // registered apps almost always need the config_id approach; set the env
  // var to the value Meta gave you in Facebook Login for Business →
  // Configurations.
  const configId = (process.env.META_FB_LOGIN_CONFIG_ID || '').trim();
  if (configId) {
    url.searchParams.set('config_id', configId);
  } else {
    url.searchParams.set('scope', SCOPES.join(','));
  }
  return url.toString();
}

export const facebookOauthService = {
  scopes: SCOPES,

  async buildAuthUrl(params: { admin_email: string; type: 'business' | 'ad_account' }): Promise<{ auth_url: string; state: string }> {
    const state = await signFbOauthState({ admin_email: params.admin_email, type: params.type });
    return { auth_url: buildAuthUrl(state), state };
  },

  async verifyState(state: string, admin_email: string) {
    const payload = await verifyFbOauthState(state);
    if (!payload) return null;
    if (payload.admin_email.toLowerCase() !== admin_email.toLowerCase()) return null;
    return payload;
  },

  // Two-step: code → short-lived → long-lived. We always return the long-lived
  // token so the connection record carries something with a usable lifetime.
  async exchangeCode(code: string): Promise<FbExchangeResult> {
    const short = await facebookGraphApi.exchangeCodeForToken(code);
    if (!short.access_token) throw new Error('no_short_lived_token');

    const long = await facebookGraphApi.exchangeShortForLongLivedUserToken(short.access_token);
    if (!long.access_token) throw new Error('no_long_lived_token');

    const me = await facebookGraphApi.meEmail(long.access_token).catch(() => ({ id: '', name: '', email: '' }));

    const expiresInSeconds = typeof long.expires_in === 'number' ? long.expires_in : 60 * 24 * 60 * 60; // 60d fallback
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    return {
      access_token_long_lived: long.access_token,
      expires_in_seconds: expiresInSeconds,
      expires_at_iso: expiresAt,
      scopes: SCOPES,
      meta_user_email: typeof me.email === 'string' ? me.email : '',
    };
  },

  // Helper exposed for the controller's "build the auth URL" path — kept
  // separate so test mocks can bypass the env-var check used by buildAuthUrl.
  _internalBuildAuthUrl: buildAuthUrl,
  _internalGraphUrl: buildGraphUrl,
};
