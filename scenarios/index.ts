import preset from './btc-nfp-2026-10-02.demo.json';
import publicPreset from './btc-nfp-public-2026-10-02.demo.json';
import { ScenarioConfig, scenarioConfigSchema, publicNfpScenarioConfigSchema, type PublicNfpScenarioConfig } from '../packages/shared/src';
export function demoScenarioConfig(): ScenarioConfig { return scenarioConfigSchema.parse(structuredClone(preset)); }
export function publicDemoScenarioConfig(): PublicNfpScenarioConfig { return publicNfpScenarioConfigSchema.parse(structuredClone(publicPreset)); }
