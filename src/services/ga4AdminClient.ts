import { ga4OauthService } from './ga4OauthService';
import type { EncryptedBlob } from '../utils/crypto';

// Thin client for the Google Analytics Admin API (v1beta), used only by the
// Connections tab: list the web streams a signed-in user can manage, and get a
// Measurement Protocol API secret on the stream they link.

const BASE = 'https://analyticsadmin.googleapis.com/v1beta';

/** Display name of the secrets this tracker creates, so a re-link reuses one. */
export const MP_SECRET_DISPLAY_NAME = 'Pennywise tracker (conversions)';

// Google requires this exact text to be acknowledged on a property before a
// Measurement Protocol secret can be created. The operator confirms it in the
// UI; we only send it after that explicit confirmation.
export const USER_DATA_COLLECTION_ACKNOWLEDGEMENT =
  'I acknowledge that I have the necessary privacy disclosures and rights from my end users for the collection and processing of their data, including the association of such data with the visitation information Google Analytics collects from my site and/or app property.';

export class Ga4AdminError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(
  token: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } } & T;
  if (!res.ok) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new Ga4AdminError(res.status, json.error?.status ? `${json.error.status}: ${msg}` : msg);
  }
  return json;
}

export interface Ga4WebStreamOption {
  measurement_id: string;
  account_name: string;
  property_id: string;
  property_name: string;
  stream_id: string;
  stream_name: string;
  default_uri?: string;
}

interface AccountSummaries {
  accountSummaries?: Array<{
    displayName?: string;
    propertySummaries?: Array<{ property?: string; displayName?: string }>;
  }>;
  nextPageToken?: string;
}

interface DataStreams {
  dataStreams?: Array<{
    name?: string;
    type?: string;
    displayName?: string;
    webStreamData?: { measurementId?: string; defaultUri?: string };
  }>;
  nextPageToken?: string;
}

interface MpSecrets {
  measurementProtocolSecrets?: Array<{ name?: string; displayName?: string; secretValue?: string }>;
  nextPageToken?: string;
}

const PROPERTY_ID_RE = /^\d{1,20}$/;
const STREAM_ID_RE = /^\d{1,20}$/;

export const ga4AdminClient = {
  /** Every GA4 web data stream the connection's Google user can see. */
  async listWebStreams(refresh_token_enc: EncryptedBlob): Promise<Ga4WebStreamOption[]> {
    const token = await ga4OauthService.accessToken(refresh_token_enc);

    const properties: Array<{ account_name: string; property_id: string; property_name: string }> = [];
    let pageToken = '';
    do {
      const page = await call<AccountSummaries>(
        token,
        `/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      );
      for (const acc of page.accountSummaries ?? []) {
        for (const p of acc.propertySummaries ?? []) {
          const property_id = (p.property ?? '').replace(/^properties\//, '');
          if (!PROPERTY_ID_RE.test(property_id)) continue;
          properties.push({ account_name: acc.displayName ?? '', property_id, property_name: p.displayName ?? '' });
        }
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);

    const streams: Ga4WebStreamOption[] = [];
    for (const prop of properties) {
      let streamPage = '';
      do {
        const page = await call<DataStreams>(
          token,
          `/properties/${prop.property_id}/dataStreams?pageSize=200${streamPage ? `&pageToken=${encodeURIComponent(streamPage)}` : ''}`
        );
        for (const s of page.dataStreams ?? []) {
          const measurement_id = s.webStreamData?.measurementId;
          if (s.type !== 'WEB_DATA_STREAM' || !measurement_id) continue;
          streams.push({
            ...prop,
            measurement_id,
            stream_id: (s.name ?? '').split('/').pop() ?? '',
            stream_name: s.displayName ?? '',
            default_uri: s.webStreamData?.defaultUri,
          });
        }
        streamPage = page.nextPageToken ?? '';
      } while (streamPage);
    }
    return streams;
  },

  /** Property currency + time zone (used as the default upload currency). */
  async getPropertySettings(
    refresh_token_enc: EncryptedBlob,
    property_id: string
  ): Promise<{ currency_code?: string; time_zone?: string }> {
    if (!PROPERTY_ID_RE.test(property_id)) throw new Ga4AdminError(400, 'invalid_property_id');
    const token = await ga4OauthService.accessToken(refresh_token_enc);
    const prop = await call<{ currencyCode?: string; timeZone?: string }>(token, `/properties/${property_id}`);
    return { currency_code: prop.currencyCode, time_zone: prop.timeZone };
  },

  /**
   * Returns a Measurement Protocol secret for the stream: reuses the one this
   * tracker created before, otherwise acknowledges user-data collection on the
   * property (required by Google) and creates a new secret.
   */
  async ensureMpSecret(
    refresh_token_enc: EncryptedBlob,
    property_id: string,
    stream_id: string
  ): Promise<{ secret_value: string; secret_name: string; created: boolean }> {
    if (!PROPERTY_ID_RE.test(property_id) || !STREAM_ID_RE.test(stream_id)) {
      throw new Ga4AdminError(400, 'invalid_property_or_stream_id');
    }
    const token = await ga4OauthService.accessToken(refresh_token_enc);
    const streamPath = `/properties/${property_id}/dataStreams/${stream_id}`;

    let pageToken = '';
    do {
      const page = await call<MpSecrets>(
        token,
        `${streamPath}/measurementProtocolSecrets?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      );
      const mine = (page.measurementProtocolSecrets ?? []).find(
        (s) => s.displayName === MP_SECRET_DISPLAY_NAME && s.secretValue
      );
      if (mine) return { secret_value: mine.secretValue!, secret_name: mine.name ?? '', created: false };
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);

    await call(token, `/properties/${property_id}:acknowledgeUserDataCollection`, {
      method: 'POST',
      body: { acknowledgement: USER_DATA_COLLECTION_ACKNOWLEDGEMENT },
    });
    const created = await call<{ name?: string; secretValue?: string }>(
      token,
      `${streamPath}/measurementProtocolSecrets`,
      { method: 'POST', body: { displayName: MP_SECRET_DISPLAY_NAME } }
    );
    if (!created.secretValue) throw new Ga4AdminError(502, 'secret_created_without_value');
    return { secret_value: created.secretValue, secret_name: created.name ?? '', created: true };
  },
};
