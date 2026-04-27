import type { EncryptedBlob } from '../utils/crypto';

export type GoogleAdsConnectionType = 'mcc' | 'child';
export type GoogleAdsConnectionStatus = 'active' | 'revoked' | 'error';

// One connection = one destination customer.
//
//  type='mcc'   → cross-account conversion tracking. customer_id is the MCC CID.
//                 The MCC owns shared conversion actions; every conversion we
//                 forward fires against the MCC and Google Ads attributes it
//                 back to the right child via the gclid.
//
//  type='child' → a single Google Ads sub-account. Even when the user
//                 authenticated through their MCC, we create one connection
//                 per picked child (each carries its own customer_id and a
//                 copy of the refresh token).
export interface GoogleAdsConnection {
  connection_id: string;
  type: GoogleAdsConnectionType;
  google_user_email: string;
  refresh_token_enc: EncryptedBlob;

  customer_id: string;                // 10-digit CID of THIS connection's account
  manager_customer_id?: string;       // MCC CID — set on type='child' when accessed via a manager
                                      //  (becomes the login-customer-id header)

  descriptive_name: string;
  currency_code: string;
  time_zone: string;

  // Cross-account conversion actions for type='mcc' (also usable as a default
  // for type='child'). When set, every forwarded conversion / Google-tagged
  // click on this connection fires the corresponding action.
  sale_conversion_action_resource?: string;
  sale_conversion_action_name?: string;
  click_conversion_action_resource?: string;
  click_conversion_action_name?: string;

  scopes: string[];
  status: GoogleAdsConnectionStatus;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
}

export interface GoogleAdsConnectionPublic {
  connection_id: string;
  type: GoogleAdsConnectionType;
  google_user_email: string;
  customer_id: string;
  manager_customer_id?: string;
  descriptive_name: string;
  currency_code: string;
  time_zone: string;
  sale_conversion_action_resource?: string;
  sale_conversion_action_name?: string;
  click_conversion_action_resource?: string;
  click_conversion_action_name?: string;
  status: GoogleAdsConnectionStatus;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
}

// Hierarchy node returned from OAuth exchange — used to populate the
// "pick which to connect" picker after consent. Not persisted as a destination.
export interface GoogleAdsCandidate {
  customer_id: string;
  manager_customer_id?: string;
  descriptive_name: string;
  currency_code: string;
  time_zone: string;
  is_manager: boolean;
  level: number;
}

// MCC-children snapshot purely for display ("these are the accounts cross-account
// tracking covers"). Stored as a sub-collection-style flat doc.
export interface GoogleAdsMccChild {
  ga_child_id: string;        // `${connection_id}_${customer_id}`
  connection_id: string;
  customer_id: string;
  descriptive_name: string;
  currency_code: string;
  time_zone: string;
  created_at?: string;
  updated_at?: string;
}

export type GoogleAdsRouteScope = 'offer' | 'network';

export interface GoogleAdsRoute {
  route_id: string;
  scope_type: GoogleAdsRouteScope;
  scope_id: string;
  target_connection_id: string;                       // FK -> google_ads_connections (must be type='child')
  sale_conversion_action_resource?: string;
  sale_conversion_action_name?: string;
  click_conversion_action_resource?: string;
  click_conversion_action_name?: string;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export type GoogleAdsUploadStatus =
  | 'pending'
  | 'sent'
  | 'partial_failure'
  | 'failed'
  | 'skipped';

export type GoogleAdsIdentifierType = 'gclid' | 'gbraid' | 'wbraid';

export type GoogleAdsUploadKind = 'conversion' | 'click';

export interface GoogleAdsUpload {
  upload_id: string;                  // uuidv7 — unique per attempt destination
  kind: GoogleAdsUploadKind;
  source_id: string;                  // conversion_id (when kind='conversion') or click_id (when kind='click')
  conversion_id?: string;
  click_id?: string;
  connection_id?: string;
  customer_id?: string;
  identifier_type?: GoogleAdsIdentifierType;
  identifier_value?: string;
  conversion_action_resource?: string;
  status: GoogleAdsUploadStatus;
  attempts: number;
  last_error?: string;
  skip_reason?: string;
  google_response?: Record<string, unknown>;
  sent_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface GoogleAdsConversionAction {
  resource_name: string;
  id: string;
  name: string;
  status: string;
  type: string;
  category?: string;
}

// Signed JWT payload that carries an encrypted refresh token between
// /oauth/exchange and /connections/finalize. Stateless — no DB row.
export interface GoogleAdsGrantPayload {
  refresh_token_enc: EncryptedBlob;
  google_user_email: string;
  scopes: string[];
  type: GoogleAdsConnectionType;
}
