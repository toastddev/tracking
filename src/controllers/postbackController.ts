import type { Context } from 'hono';
import { postbackService } from '../services/postbackService';
import { logger } from '../utils/logger';

async function readPayload(c: Context, method: 'GET' | 'POST'): Promise<Record<string, string>> {
  if (method === 'GET') return c.req.query();

  const contentType = c.req.header('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v != null) out[k] = String(v);
    }
    return out;
  }

  // application/x-www-form-urlencoded or multipart/form-data
  const form = await c.req.parseBody().catch(() => ({}));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function clientIp(c: Context): string | undefined {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    undefined
  );
}

export const postbackController = {
  async handle(c: Context) {
    const network_id = c.req.param('network_id');
    if (!network_id) {
      return c.json({ status: 'error', reason: 'missing_network_id' }, 400);
    }

    const method = c.req.method.toUpperCase() === 'POST' ? 'POST' : 'GET';
    const raw = await readPayload(c, method);

    const result = await postbackService.record({
      network_id,
      raw,
      method,
      source_ip: clientIp(c),
    });

    if (!result.ok) {
      logger.warn('postback_rejected', { network_id, reason: result.reason, raw });
      const status =
        result.reason === 'unauthorized' ? 401 :
        result.reason === 'unknown_network' ? 404 :
        400;
      return c.json({ status: 'error', reason: result.reason }, status);
    }

    logger.info('postback_accepted', {
      network_id,
      conversion_id: result.conversion_id,
      verified: result.verified,
      verification_reason: result.verification_reason,
    });
    return c.json(
      {
        status: 'ok',
        conversion_id: result.conversion_id,
        verified: result.verified,
        verification_reason: result.verification_reason,
      },
      200
    );
  },
};
