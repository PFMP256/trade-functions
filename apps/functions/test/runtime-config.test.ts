import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../src/runtime';
import { anyScenarioConfigSchema, PUBLIC_NFP_STRATEGY_ID, STRATEGY_ID } from '../../../packages/shared/src';

afterEach(() => vi.unstubAllEnvs());
function defaults() {
  for (const name of ['SCENARIO_CONFIG_PATH', 'TRADING_MODE', 'BYBIT_ENVIRONMENT', 'ALLOW_NEW_ENTRIES']) vi.stubEnv(name, undefined);
}
describe('runtime scenario selection', () => {
  it('defaults to the public variant in dry_run without changing the dated demo window', () => {
    defaults(); const config = anyScenarioConfigSchema.parse(loadScenario());
    expect(config.strategyId).toBe(PUBLIC_NFP_STRATEGY_ID); expect(config.tradingMode).toBe('dry_run');
    expect(config.demo).toBe(true); expect(config.validationStatus).toBe('UNVALIDATED');
    expect(config.expiresAtUtc).toBe('2026-10-02T21:41:00Z');
    expect(config.execution).toMatchObject({ targetPositionNotionalUsd: '2000', leverage: '20' });
  });
  it('loads the original strategy only when its scenario is selected explicitly', () => {
    defaults(); vi.stubEnv('SCENARIO_CONFIG_PATH', 'scenarios/btc-nfp-2026-10-02.demo.json');
    const config = anyScenarioConfigSchema.parse(loadScenario());
    expect(config.strategyId).toBe(STRATEGY_ID); expect(config.tradingMode).toBe('dry_run');
  });
});
