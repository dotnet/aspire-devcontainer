import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'without-dotnet': { type: 'boolean', default: false },
  },
});
assert.ok(values.output, '--output is required.');

const configuration = JSON.parse(readFileSync('.devcontainer/devcontainer.json', 'utf8'));
if (values['without-dotnet']) {
  const features = Object.keys(configuration.features)
    .filter(feature => feature.startsWith('ghcr.io/devcontainers/features/dotnet:'));
  assert.equal(features.length, 1, 'Expected one standalone .NET SDK feature to omit.');
  delete configuration.features[features[0]];
}

const output = resolve(values.output);
assert.notEqual(output, resolve('.devcontainer/devcontainer.json'), 'Use a separate output path for the test configuration.');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(configuration, null, 2)}\n`);
