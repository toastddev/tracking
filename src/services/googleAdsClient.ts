import { GoogleAdsApi } from 'google-ads-api';
import type { Customer } from 'google-ads-api';
import { decryptSecret } from '../utils/crypto';
import type { GoogleAdsConnection } from '../types/googleAds';

let _api: GoogleAdsApi | null = null;

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

export function googleAdsApi(): GoogleAdsApi {
  if (_api) return _api;
  _api = new GoogleAdsApi({
    client_id: readEnv('GOOGLE_OAUTH_CLIENT_ID'),
    client_secret: readEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    developer_token: readEnv('GOOGLE_ADS_DEVELOPER_TOKEN'),
  });
  return _api;
}

// Build a per-customer client. login_customer_id is the MCC CID (set only when
// accessed through a manager); customer_id is always the operating account.
export function buildCustomer(args: {
  connection: GoogleAdsConnection;
  customer_id: string;
  login_customer_id?: string;
}): Customer {
  const refresh_token = decryptSecret(args.connection.refresh_token_enc);
  return googleAdsApi().Customer({
    customer_id: args.customer_id,
    refresh_token,
    login_customer_id: args.login_customer_id,
  });
}

// listAccessibleCustomers does NOT need a Customer — only a refresh token.
export async function listAccessibleResourceNames(connection: GoogleAdsConnection): Promise<string[]> {
  const refresh_token = decryptSecret(connection.refresh_token_enc);
  const res = await googleAdsApi().listAccessibleCustomers(refresh_token);
  return res.resource_names ?? [];
}

export function customerIdFromResourceName(resourceName: string): string {
  // "customers/1234567890" → "1234567890"
  const m = resourceName.match(/customers\/(\d+)/);
  return m ? m[1]! : resourceName;
}
