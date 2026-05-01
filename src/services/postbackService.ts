import { generateConversionId } from '../utils/idGenerator';
import { logger } from '../utils/logger';
import {
  clickRepository,
  conversionRepository,
  affiliateApiRepository,
  offerReportRepository,
} from '../firestore';
import { networkService } from './networkService';
import { googleAdsForwardingService } from './googleAdsForwardingService';
import type { ConversionRecord, Network, VerificationReason } from '../types';

export interface PostbackInput {
  network_id: string;
  raw: Record<string, string>;
  method: 'GET' | 'POST';
  source_ip?: string;
}

export type PostbackResult =
  | { ok: true; conversion_id: string; verified: boolean; verification_reason: VerificationReason }
  | {
      ok: false;
      reason:
        | 'unknown_network'
        | 'network_inactive'
        | 'missing_click_id'
        | 'unauthorized'
        | 'persist_failed';
    };

interface MappedFields {
  click_id?: string;
  payout?: number;
  currency?: string;
  status?: string;
  txn_id?: string;
  network_timestamp?: string;
}

function lowercaseKeys(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(raw)) out[k.toLowerCase()] = raw[k]!;
  return out;
}

function pick(lowerRaw: Record<string, string>, key: string): string | undefined {
  const v = lowerRaw[key];
  return v != null && v !== '' ? v : undefined;
}

// URL param names are fixed canonical defaults — the network substitutes
// macros before firing, so the backend always receives these exact names.
// The Network.mapping_* fields are now UI-only (used to render the URL
// template in the admin dashboard with the right macro syntax).
function applyMapping(_network: Network, raw: Record<string, string>): MappedFields {
  const r = lowercaseKeys(raw);
  const payoutRaw = pick(r, 'payout');
  const payoutNum = payoutRaw != null ? Number(payoutRaw) : undefined;
  return {
    click_id: pick(r, 'click_id'),
    payout: payoutNum != null && !Number.isNaN(payoutNum) ? payoutNum : undefined,
    currency: pick(r, 'currency'),
    status: pick(r, 'status'),
    txn_id: pick(r, 'transaction_id'),
    network_timestamp: pick(r, 'event_time'),
  };
}

// Postback verification hook. Today it's a no-op so the endpoint is ready for
// integration testing. Replace with per-network secret/HMAC/IP allowlist.
function verifyPostback(_input: PostbackInput): { ok: true } | { ok: false; reason: 'unauthorized' } {
  return { ok: true };
}

export const postbackService = {
  async record(input: PostbackInput): Promise<PostbackResult> {
    const auth = verifyPostback(input);
    if (!auth.ok) return { ok: false, reason: 'unauthorized' };

    const network = await networkService.fetch(input.network_id);
    if (!network) return { ok: false, reason: 'unknown_network' };
    if (network.status !== 'active') return { ok: false, reason: 'network_inactive' };

    const mapped = applyMapping(network, input.raw);
    if (!mapped.click_id) return { ok: false, reason: 'missing_click_id' };

    // Click verification: look the click_id up in Firestore. Even when it
    // doesn't resolve we still persist the conversion (verified: false) so
    // the audit trail captures every postback the network sent us.
    const click = await clickRepository.getById(mapped.click_id);
    const verified = click !== null;
    const verification_reason: VerificationReason = verified ? 'click_found' : 'unknown_click_id';

    // If the network is mapped to an affiliate API and that API is active,
    // the API pull is the source of truth — the postback becomes audit-only
    // ("shadow"). We still persist + return ok so the network sees a 200.
    let shadow = false;
    if (network.postback_api_id) {
      const api = await affiliateApiRepository.getById(network.postback_api_id).catch(() => null);
      if (api && api.status === 'active' && api.schedule.enabled) shadow = true;
    }

    const conv: ConversionRecord = {
      conversion_id: generateConversionId(),
      network_id: network.network_id,
      click_id: mapped.click_id,
      offer_id: click?.offer_id,
      payout: mapped.payout,
      currency: mapped.currency,
      status: mapped.status ?? network.default_status ?? 'approved',
      txn_id: mapped.txn_id,
      network_timestamp: mapped.network_timestamp,
      raw_payload: input.raw,
      source_ip: input.source_ip,
      method: input.method,
      verified,
      verification_reason,
      source: 'postback',
      shadow,
      created_at: new Date().toISOString(),
    };

    try {
      await conversionRepository.insert(conv);
    } catch (err) {
      logger.error('conversion_persist_failed', {
        network_id: conv.network_id,
        click_id: conv.click_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: 'persist_failed' };
    }

    // Roll-up into offer_reports. Skip shadow rows — those are audit-only
    // (the affiliate API pull is the source of truth and rolls up its own
    // increments). Unverified rows still increment postbacks/unverified so
    // the offer report mirrors the postback log.
    if (!shadow) {
      const offerForReport = click?.offer_id || 'unknown';
      offerReportRepository
        .incrementConversion({
          offer_id: offerForReport,
          network_id: conv.network_id,
          at: new Date(conv.created_at),
          verified: conv.verified,
          status: conv.status,
          payout: conv.payout,
        })
        .catch((err: unknown) => {
          logger.warn('offer_report_conversion_increment_failed', {
            network_id: conv.network_id,
            offer_id: offerForReport,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // Fan out to Google Ads in the background. Never block or fail the
    // postback response on outbound forwarding — the conversion is already
    // persisted; the forwarder writes its own audit doc and surfaces
    // sent/skipped/failed status separately. Skip when shadow — the API
    // run will trigger the forward instead so we don't double-upload.
    if (!shadow) {
      googleAdsForwardingService.forgetConversion({ conversion: conv, click });
    }

    return { ok: true, conversion_id: conv.conversion_id, verified, verification_reason };
  },
};
