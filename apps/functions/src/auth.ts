import { OAuth2Client } from 'google-auth-library';

export interface AuthRequest { headers: Record<string, string | string[] | undefined>; }
export interface Identity { email: string; }
export type TokenVerifier = (token: string, audience: string) => Promise<{email?: string; email_verified?: boolean; iss?: string}>;
const google = new OAuth2Client();
const verify: TokenVerifier = async (idToken, audience) => {
  const ticket = await google.verifyIdToken({ idToken, audience });
  return ticket.getPayload() ?? {};
};
export async function authenticate(req: AuthRequest, audience: string, allowedEmails: string[], verifier: TokenVerifier = verify): Promise<Identity> {
  const header = req.headers.authorization;
  if (!audience || !allowedEmails.length || typeof header !== 'string' || !header.startsWith('Bearer ')) throw new Error('UNAUTHENTICATED');
  const payload = await verifier(header.slice(7), audience);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss ?? '') || !payload.email_verified || !payload.email || !allowedEmails.includes(payload.email)) throw new Error('FORBIDDEN');
  return { email: payload.email };
}

export function scheduledTime(header: string | string[] | undefined, now: Date): string {
  if (header !== undefined) {
    if (typeof header !== 'string' || !Number.isFinite(Date.parse(header)) || Date.parse(header) > now.getTime() + 30_000) throw new Error('INVALID_SCHEDULE_TIME');
    return new Date(header).toISOString();
  }
  return new Date(Math.floor(now.getTime() / 300_000) * 300_000).toISOString();
}
