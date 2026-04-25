import type { Context, Next } from 'hono';
import { authService } from '../services/authService';

export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return c.json({ error: 'unauthorized' }, 401);

  const session = await authService.verify(match[1]!);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  c.set('admin_email' as never, session.email as never);
  await next();
}
