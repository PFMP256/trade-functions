import { DateTime } from 'luxon';
import { marketCalendarSchema, type MarketCalendar } from '../../shared/src';
import { ProviderError } from './http';

export const NYSE_CALENDAR_SOURCE = 'https://www.nyse.com/trade/hours-calendars';
export const BLS_CALENDAR_SOURCE = 'https://www.bls.gov/schedule/2026/10_sched.htm';
export const BLS_SEPTEMBER_2026_EVENT = {
  eventId: 'bls-employment-situation-2026-09', period: '2026-09',
  scheduledAtUtc: '2026-10-02T12:30:00.000Z', sourceUrl: BLS_CALENDAR_SOURCE,
  verifiedOn: '2026-10-01',
} as const;

// Explicit, bounded manifest reviewed against the NYSE official 2026 schedule.
// These are equity-market holidays, not US federal or bond-market holidays.
export const NYSE_2026_HOLIDAYS = [
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
] as const;
export const NYSE_2026_EARLY_CLOSES: Readonly<Record<string, string>> = {
  '2026-11-27': '13:00', '2026-12-24': '13:00',
};

/** A deployment must preserve its initial verification time; don't call on every invocation to fake a refresh. */
export function createUsEquitiesCalendar2026(verifiedAtUtc: string): MarketCalendar {
  const verified = DateTime.fromISO(verifiedAtUtc, { setZone: true });
  if (!verified.isValid || !verifiedAtUtc.endsWith('Z')) throw new ProviderError('CALENDAR_INVALID_VERIFICATION_TIME');
  const holidays = new Set<string>(NYSE_2026_HOLIDAYS);
  const sessions: MarketCalendar['sessions'] = [];
  for (let day = DateTime.fromISO('2026-01-01', { zone: 'America/New_York' }); day.year === 2026; day = day.plus({ days: 1 })) {
    const date = day.toISODate()!;
    if (day.weekday > 5 || holidays.has(date)) continue;
    const closeLocal = NYSE_2026_EARLY_CLOSES[date] ?? '16:00';
    const close = DateTime.fromISO(`${date}T${closeLocal}:00`, { zone: 'America/New_York' }).toUTC().toISO()!;
    sessions.push({ sessionDate: date, closeAtUtc: close });
  }
  return marketCalendarSchema.parse({ calendarId: 'NYSE-US-EQUITIES-2026-reviewed-2026-10-01',
    coverageFrom: '2026-01-01', coverageTo: '2026-12-31', sessions,
    provenance: { sourceId: 'nyse-calendar', sourceUrl: NYSE_CALENDAR_SOURCE, observedAt: verifiedAtUtc,
      publishedAt: null, firstSeenAt: verifiedAtUtc, availableAt: verifiedAtUtc, fetchedAt: verifiedAtUtc,
      revision: 'reviewed-2026-10-01', verified: true, synthetic: false, conflicts: [] },
  });
}

/** Never rolls back from a missing ETF report: this resolves the required session independently of reports. */
export function resolveLatestClosedSession(nowUtc: string | Date, calendarInput: MarketCalendar): MarketCalendar['sessions'][number] {
  const calendar = marketCalendarSchema.parse(calendarInput);
  const now = typeof nowUtc === 'string' ? DateTime.fromISO(nowUtc, { setZone: true }) : DateTime.fromJSDate(nowUtc);
  if (!now.isValid) throw new ProviderError('CALENDAR_INVALID_EVALUATION_TIME');
  const localDate = now.setZone('America/New_York').toISODate()!;
  if (localDate < calendar.coverageFrom || localDate > calendar.coverageTo) throw new ProviderError('MARKET_CALENDAR_OUT_OF_COVERAGE');
  const seen = new Set<string>();
  for (const session of calendar.sessions) {
    const close = DateTime.fromISO(session.closeAtUtc, { setZone: true });
    if (seen.has(session.sessionDate) || session.sessionDate < calendar.coverageFrom || session.sessionDate > calendar.coverageTo ||
        close.setZone('America/New_York').toISODate() !== session.sessionDate) throw new ProviderError('MARKET_CALENDAR_INVALID_SESSIONS');
    seen.add(session.sessionDate);
  }
  const latest = calendar.sessions.filter(session => Date.parse(session.closeAtUtc) <= now.toMillis())
    .sort((left, right) => Date.parse(right.closeAtUtc) - Date.parse(left.closeAtUtc))[0];
  if (!latest) throw new ProviderError('MARKET_CALENDAR_NO_CLOSED_SESSION');
  return latest;
}
