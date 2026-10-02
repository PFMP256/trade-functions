import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeFixture } from './index';
import { makePublicFixture } from './public';

for (const direction of ['LONG','SHORT'] as const) {
  writeFileSync(resolve(__dirname,`${direction.toLowerCase()}.json`),JSON.stringify(makeFixture(direction).snapshot,null,2)+'\n');
  writeFileSync(resolve(__dirname,`public-${direction.toLowerCase()}.json`),JSON.stringify(makePublicFixture(direction).snapshot,null,2)+'\n');
}
