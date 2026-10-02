import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { anyScenarioConfigSchema, scenarioConfigSchema, publicNfpScenarioConfigSchema, snapshotSchema, evaluationSchema } from '../packages/shared/src';
import { structuredFeedSchema, allowedSourcesSchema } from '../packages/data-providers/src';
import { ExecutionRequestSchema, ExecutorSettingsSchema, ExecutionResultSchema } from '../packages/execution/bybit/types';
import { ingestEnvelopeSchema } from '../apps/functions/src/feed-store';
const schemas = {scenario:anyScenarioConfigSchema,originalScenario:scenarioConfigSchema,publicNfpScenario:publicNfpScenarioConfigSchema,snapshot:snapshotSchema,evaluation:evaluationSchema,structuredFeed:structuredFeedSchema,
  sourceRegistry:allowedSourcesSchema,executionRequest:ExecutionRequestSchema,executionResult:ExecutionResultSchema,executorSettings:ExecutorSettingsSchema,ingestion:ingestEnvelopeSchema};
mkdirSync(resolve('schemas'),{recursive:true});
// Avoid recursively expanding the union of every schema in the converter's generic type.
const convert = zodToJsonSchema as unknown as (schema: unknown, options: {name:string;$refStrategy:'none'}) => unknown;
for (const [name,schema] of Object.entries(schemas)) writeFileSync(resolve('schemas',`${name}.schema.json`),JSON.stringify(convert(schema,{name,$refStrategy:'none'}),null,2)+'\n');
console.log('JSON Schemas generated; runtime Zod also applies semantic refinements.');
