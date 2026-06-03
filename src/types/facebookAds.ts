import type { EncryptedBlob } from '../utils/crypto';

// Meta (Facebook) integration types — parallel to ../types/googleAds.ts.
// Meta hierarchy maps to the GAds shape like so:
//   GAds MCC   ≈ Meta Business Manager (BM)         → type='business'
//   GAds child ≈ Meta Ad Account (act_<id>)         → type='ad_account'
//   GAds conversion_action ≈ Meta dataset_id + event_name (CAPI destination)
// Meta tokens are long-lived USER tokens (~60 days) — no refresh_token concept,
// so we store the token directly in `access_token_enc` and track `expires_at`.

export type FacebookConnectionType = 'business' | 'ad_account';
export type FacebookConnectionStatus = 'active' | 'revoked' | 'error' | 'expiring';

// One connection = one destination ad account (or one BM that fans out to all
// its ad accounts). Mirrors GoogleAdsConnection.
//
//  type='business'    → cross-account CAPI forwarding. customer_id-equivalent
//                        is `business_id`. Every verified conversion fires to
//                        the connection's dataset; Meta attributes back to the
//                        ad account that ran the ad via fbc/fbp/fbclid.
//
//  type='ad_account'  → a single Meta ad account. Even when the user signed in
//                        with full BM access, each picked ad account is its
//                        own connection (its own dataset, its own token copy).
export interface FacebookConnection {
  connection_id: string;
  type: FacebookConnectionType;

  meta_user_email: string;
  // Long-lived user access token (~60 days). Encrypted at rest.
  access_token_enc: EncryptedBlob;
  // ISO timestamp of token expiry as reported by Graph at exchange time. Used
  // to surface an "expiring" banner before silent CAPI failures begin.
  access_token_expires_at?: string;

  // For type='business': the BM id this connection is rooted at. ad_account_id
  // is also populated (it's the dataset's parent for the default pixel).
  // For type='ad_account': the act_<id>; business_id is optional (set when the
  // ad account was discovered through a BM).
  business_id?: string;
  ad_account_id: string;            // act_<digits>

  // Default dataset/pixel that CAPI events POST to. One ad account can host
  // multiple datasets — operator picks the canonical one at connection time;
  // routes can override per-offer/per-network in the routes table.
  dataset_id?: string;
  dataset_name?: string;

  // Human metadata pulled from Graph at connection time.
  name: string;                     // ad account or BM display name
  currency_code: string;
  time_zone: string;
  account_status?: string;          // Meta's account_status enum (1=ACTIVE, 2=DISABLED, …)

  // CAPI event mapping (Meta's conversion-action equivalent). Standard events
  // are 'Purchase', 'Lead', 'CompleteRegistration', 'Subscribe', 'AddToCart',
  // etc. Custom events are arbitrary strings the operator has registered with
  // Meta. Blank = skip that kind of forwarding entirely.
  sale_event_name?: string;
  sale_event_dataset_id?: string;   // denormalised — usually = `dataset_id`
  click_event_name?: string;        // optional; non-standard event for click-fan-out
  click_event_dataset_id?: string;

  scopes: string[];
  status: FacebookConnectionStatus;
  last_error?: string;

  created_at?: string;
  updated_at?: string;
}

// Public-facing connection (the AES blob and any other secret-bearing field
// are stripped before this leaves the API).
export interface FacebookConnectionPublic {
  connection_id: string;
  type: FacebookConnectionType;
  meta_user_email: string;
  access_token_expires_at?: string;
  business_id?: string;
  ad_account_id: string;
  dataset_id?: string;
  dataset_name?: string;
  name: string;
  currency_code: string;
  time_zone: string;
  account_status?: string;
  sale_event_name?: string;
  sale_event_dataset_id?: string;
  click_event_name?: string;
  click_event_dataset_id?: string;
  status: FacebookConnectionStatus;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
}

// Hierarchy node returned from OAuth exchange. Populates the picker after the
// user consents. Not persisted as a destination on its own.
export interface FacebookCandidate {
  type: FacebookConnectionType;
  // For type='ad_account': the act_<id>. For type='business': the BM id.
  id: string;
  business_id?: string;             // set when discovered through a BM
  name: string;
  currency_code: string;            // ad accounts only — BMs don't have one
  time_zone: string;                // ad accounts only
  account_status?: string;          // ad accounts only
}

// Display-only snapshot of an BM's child ad accounts (for the per-connection
// "coverage" panel). Stored as a flat doc keyed by `${connection_id}_${ad_account_id}`.
export interface FacebookBusinessChild {
  fb_child_id: string;
  connection_id: string;
  ad_account_id: string;
  name: string;
  currency_code: string;
  time_zone: string;
  account_status?: string;
  created_at?: string;
  updated_at?: string;
}

export type FacebookRouteScope = 'offer' | 'network';

export interface FacebookRoute {
  route_id: string;
  scope_type: FacebookRouteScope;
  scope_id: string;
  target_connection_id: string;       // FK -> facebook_connections (must be type='ad_account')
  sale_event_name?: string;
  sale_event_dataset_id?: string;
  click_event_name?: string;
  click_event_dataset_id?: string;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export type FacebookUploadStatus =
  | 'pending'
  | 'sent'
  | 'partial_failure'
  | 'failed'
  | 'skipped';

// Meta user_data identifiers. `fbc` is the canonical cookie value
// (fb.1.<ms>.<fbclid>); `fbp` is the browser pixel cookie; `fbclid` is the raw
// URL param. Order of preference at dispatch time: fbc > fbclid > fbp.
export type FacebookIdentifierType = 'fbc' | 'fbp' | 'fbclid';

export type FacebookUploadKind = 'conversion' | 'click';

export interface FacebookUpload {
  upload_id: string;                  // uuidv7 — one per (kind, source, destination)
  kind: FacebookUploadKind;
  source_id: string;                  // conversion_id (conversion) or click_id (click)
  conversion_id?: string;
  click_id?: string;
  connection_id?: string;
  ad_account_id?: string;
  dataset_id?: string;
  event_name?: string;
  event_id?: string;                  // Meta's dedupe key — same role as GAds order_id
  identifier_type?: FacebookIdentifierType;
  identifier_value?: string;
  status: FacebookUploadStatus;
  attempts: number;
  last_error?: string;
  skip_reason?: string;
  // Subset of the Graph API response (events_received / fbtrace_id / messages
  // for partial_failure). The full JSON can be huge; we keep only what matters
  // for debugging.
  meta_response?: Record<string, unknown>;
  sent_at?: string;
  created_at?: string;
  updated_at?: string;
}

// A Meta custom event registered against a dataset. Equivalent to a GAds
// ConversionAction. Standard events ('Purchase', 'Lead', ...) are universally
// available; custom events must be created in Events Manager first.
export interface FacebookCustomEvent {
  dataset_id: string;
  event_name: string;
  // 'standard' for built-in Meta events, 'custom' for operator-registered.
  kind: 'standard' | 'custom';
  // Optional — Meta exposes a description for custom events but not standard.
  description?: string;
}

// Signed JWT payload that carries the encrypted long-lived token between
// /oauth/exchange and /finalize. Same idea as GoogleAdsGrantPayload.
export interface FacebookGrantPayload {
  access_token_enc: EncryptedBlob;
  access_token_expires_at?: string;
  meta_user_email: string;
  scopes: string[];
  type: FacebookConnectionType;
}
