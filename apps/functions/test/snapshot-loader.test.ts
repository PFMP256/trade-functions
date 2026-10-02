import { describe, expect, it, vi } from 'vitest';
import { makePublicFixture } from '../../../fixtures/public';
import { makeFixture } from '../../../fixtures';
import { emptyStructuredFeed, type StructuredFeed } from '../../../packages/data-providers/src';
import { loadRuntimeSnapshot, type RuntimeSnapshotOptions } from '../src/snapshot-loader';

function setup() {
  const fixture = makePublicFixture();
  const structured: StructuredFeed = { ...emptyStructuredFeed(), calendar: fixture.snapshot.calendar,
    employment: fixture.snapshot.employment, usdPerUsdt: fixture.snapshot.usdPerUsdt };
  const latestStructured = vi.fn(async (): Promise<StructuredFeed | undefined> => { throw new Error('manual feed unavailable'); });
  const publicSources = vi.fn(async () => ({ structured, errors: [] as string[] }));
  const options: RuntimeSnapshotOptions = { config: fixture.config, environment: 'testnet', now: new Date(fixture.now),
    publicDataEnabled: true, latestStructured, publicSources, quoteProvider: { getQuote: async () => fixture.snapshot.quote! },
    clock: () => new Date(fixture.now) };
  return { fixture, structured, options, latestStructured, publicSources };
}

describe('runtime acquisition with exclusively public sources', () => {
  it('can acquire a complete public snapshot when manual feed storage is unavailable', async () => {
    const { options, latestStructured, publicSources } = setup();
    const snapshot = await loadRuntimeSnapshot(options);
    expect(latestStructured).not.toHaveBeenCalled(); expect(publicSources).toHaveBeenCalledOnce();
    expect(snapshot.calendar).not.toBeNull(); expect(snapshot.employment).not.toBeNull(); expect(snapshot.usdPerUsdt).not.toBeNull();
    expect(snapshot.providerErrors).toEqual([]);
    expect(snapshot).toMatchObject({ consensus: null, treasury: [], etf: null, marketCalendar: null });
  });
  it('cannot silently switch the public strategy to manual data when public acquisition is disabled', async () => {
    const { options, latestStructured, publicSources } = setup(); options.publicDataEnabled = false;
    const snapshot = await loadRuntimeSnapshot(options);
    expect(latestStructured).not.toHaveBeenCalled(); expect(publicSources).not.toHaveBeenCalled();
    expect(snapshot.employment).toBeNull(); expect(snapshot.providerErrors).toContain('PUBLIC_SOURCES_REQUIRED');
  });
  it('preserves acquisition errors and missing data rather than restoring an old manual report', async () => {
    const { options, publicSources, latestStructured } = setup();
    publicSources.mockResolvedValue({ structured: emptyStructuredFeed(), errors: ['BLS_EMPLOYMENT_STRUCTURE_CHANGED'] });
    const snapshot = await loadRuntimeSnapshot(options);
    expect(snapshot.employment).toBeNull(); expect(snapshot.providerErrors).toContain('BLS_EMPLOYMENT_STRUCTURE_CHANGED');
    expect(latestStructured).not.toHaveBeenCalled();
  });
  it('places the snapshot cutoff after the new public response was received', async () => {
    const { options, structured } = setup();
    options.now = new Date('2026-10-02T12:29:00Z');
    const snapshot = await loadRuntimeSnapshot(options);
    expect(snapshot.employment).toEqual(structured.employment);
    expect(snapshot.providerErrors).not.toContain('STRUCTURED_FEED_AFTER_AS_OF');
  });
  it('keeps manual ingestion available for the explicitly selected original strategy', async () => {
    const { options, structured, latestStructured, publicSources } = setup();
    options.config = makeFixture().config; options.publicDataEnabled = false;
    latestStructured.mockResolvedValue(structured);
    const snapshot = await loadRuntimeSnapshot(options);
    expect(latestStructured).toHaveBeenCalledWith(options.now.toISOString());
    expect(publicSources).not.toHaveBeenCalled(); expect(snapshot.employment).toEqual(structured.employment);
  });
});
