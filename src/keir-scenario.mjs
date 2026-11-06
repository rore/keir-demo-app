import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { lexical } from '../vendor/keir-verification/scenario-lexical.mjs';

const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, ownProperties: true });
const schemas = new Map([
  ['keir-scenario/1', 'scenario.schema.json'],
  ['keir-scenario/2', 'scenario-v2.schema.json'],
].map(([format, file]) => {
  const schema = JSON.parse(readFileSync(new URL('../vendor/keir-verification/' + file, import.meta.url)));
  return [format, ajv.compile(schema)];
}));

export function decodeKeirScenario(bytes) {
  const row = lexical(bytes);
  assert.ok(schemas.get(row?.format)?.(row), 'Scenario schema');
  const { stubs, expect } = row;
  for (const item of [...stubs, ...expect.calls, ...expect.outcome.trace, ...expect.outcome.effects, ...(expect.consumption.effects ?? [])]) {
    for (const field of ['capability', 'version']) {
      if (Object.hasOwn(item, field)) assert.ok(Buffer.byteLength(item[field]) <= 256, 'Scenario byte field');
    }
  }
  for (const error of [expect.outcome.error, expect.consumption.error]) {
    if (!error) continue;
    assert.ok(Buffer.byteLength(error.path) <= 1024, 'Scenario byte field');
    if (error.cause) assert.ok(Buffer.byteLength(error.cause.path) <= 1024, 'Scenario byte field');
  }
  return row;
}
