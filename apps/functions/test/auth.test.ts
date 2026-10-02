import { describe, expect, it } from 'vitest';
import { authenticate, scheduledTime } from '../src/auth';
describe('service account authentication', () => {
  const allowed = ['scheduler@example.iam.gserviceaccount.com'];
  it('requires bearer and a configured audience and allowlist', async () => {
    await expect(authenticate({headers:{}}, 'https://service', allowed)).rejects.toThrow('UNAUTHENTICATED');
    await expect(authenticate({headers:{authorization:'Bearer secret'}}, '', allowed)).rejects.toThrow('UNAUTHENTICATED');
  });
  it('checks issuer, audience through verifier, and verified email', async () => {
    const result = await authenticate({headers:{authorization:'Bearer token'}}, 'https://service', allowed, async (token, audience) => {
      expect(token).toBe('token'); expect(audience).toBe('https://service'); return {iss:'https://accounts.google.com', email:allowed[0], email_verified:true};
    });
    expect(result.email).toBe(allowed[0]);
    await expect(authenticate({headers:{authorization:'Bearer token'}}, 'https://service', allowed, async () => ({iss:'https://accounts.google.com',email:'attacker@example.com',email_verified:true}))).rejects.toThrow('FORBIDDEN');
  });
  it('keeps scheduler retry identity, rejects future time', () => {
    const now = new Date('2026-10-02T12:50:04Z');
    expect(scheduledTime('2026-10-02T12:45:00Z', now)).toBe('2026-10-02T12:45:00.000Z');
    expect(scheduledTime(undefined, now)).toBe('2026-10-02T12:50:00.000Z');
    expect(() => scheduledTime('2026-10-03T00:00:00Z', now)).toThrow();
  });
});
