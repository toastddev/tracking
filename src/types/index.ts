export interface Offer {
  offer_id: string;
  name: string;
  base_url: string;
  status: 'active' | 'paused';
  default_params?: Record<string, string>;
  created_at?: string;
  updated_at?: string;
}

export interface AdIds {
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  ttclid?: string;
  msclkid?: string;
  [key: string]: string | undefined;
}

export interface ClickRecord {
  click_id: string;
  offer_id: string;
  aff_id: string;
  sub_params: Record<string, string>;
  ad_ids: AdIds;
  ip?: string;
  user_agent?: string;
  referrer?: string;
  country?: string;
  redirect_url: string;
  created_at: string;
}

// Per-network postback parameter mapping. Editable from the admin UI by
// updating the doc — no code change required to onboard a new network.
export interface Network {
  network_id: string;
  name: string;
  status: 'active' | 'paused';
  // Each mapping_* value is the parameter name the network actually sends.
  // E.g. Kelkoo posts back with `cid` for the click id, so mapping_click_id = "cid".
  mapping_click_id: string;
  mapping_payout?: string;
  mapping_currency?: string;
  mapping_status?: string;
  mapping_txn_id?: string;
  mapping_timestamp?: string;
  // Additional network-specific parameters. Key is the canonical name used
  // in the example URL placeholder; value is the parameter name the network sends.
  extra_mappings?: Record<string, string>;
  default_status?: string;
  created_at?: string;
  updated_at?: string;
}

export type VerificationReason =
  | 'click_found'
  | 'unknown_click_id';

export interface ConversionRecord {
  conversion_id: string;
  network_id: string;
  click_id: string;
  offer_id?: string;            // denormalised from the click when verified
  payout?: number;
  currency?: string;
  status?: string;
  txn_id?: string;
  network_timestamp?: string;   // event time as reported by the network, if mapped
  raw_payload: Record<string, string>;
  source_ip?: string;
  method: 'GET' | 'POST';
  verified: boolean;            // true iff click_id resolved to an existing click doc
  verification_reason: VerificationReason;
  created_at: string;
}
