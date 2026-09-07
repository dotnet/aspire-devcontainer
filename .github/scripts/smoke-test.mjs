import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

process.env.ASPIRE_CLI_TELEMETRY_OPTOUT = '1';
process.env.DOTNET_CLI_TELEMETRY_OPTOUT = '1';

const scenarios = {
  python: { template: 'aspire-py-starter', api: 'app', frontend: 'frontend', cache: true },
  csharp: { template: 'aspire-starter', api: 'apiservice', frontend: 'webfrontend', cache: true },
  'typescript-no-dotnet': { template: 'aspire-ts-starter', api: 'app', frontend: 'frontend', cache: false },
};
const scenarioName = process.argv[2] ?? 'python';
assert.ok(Object.hasOwn(scenarios, scenarioName), `Unknown scenario: ${scenarioName}`);
const scenario = scenarios[scenarioName];
const withoutDotnet = scenarioName === 'typescript-no-dotnet';

function execute(command, args, { cwd = process.cwd(), capture = false, input } = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
  });
}

function assertNoDotnet() {
  const result = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
  assert.equal(result.error?.code, 'ENOENT', 'The TypeScript scenario must have no standalone dotnet on PATH.');
  console.log('No standalone dotnet found on PATH.');
}

assert.equal(process.platform, 'linux', 'Run this script inside the devcontainer.');
assert.notEqual(process.getuid(), 0, 'The remote user must not be root.');
accessSync('.devcontainer/devcontainer.json', constants.R_OK);
accessSync('.', constants.W_OK);

// Check the lifecycle hook before Aspire starts and can perform its own certificate setup.
const trustDirectory = join(homedir(), '.aspnet', 'dev-certs', 'trust');
const certificates = readdirSync(trustDirectory).filter(name => name.endsWith('.pem'));
assert.ok(certificates.length > 0, 'The startup hook must create a development certificate.');
for (const certificate of certificates) {
  execute('openssl', ['verify', join(trustDirectory, certificate)]);
}

for (const command of ['node', 'npm', 'python3', 'uv', 'pwsh', 'aspire']) {
  execute(command, ['--version']);
}
if (withoutDotnet) {
  assertNoDotnet();
} else {
  execute('dotnet', ['--version']);
}

execute('docker', ['info', '--format', 'Docker server: {{.ServerVersion}}']);
execute('docker', ['run', '--rm', 'hello-world']);

const testDirectory = mkdtempSync(join(homedir(), '.aspire-devcontainer-test-'));
const appDirectory = join(testDirectory, 'app');
const dotnetDirectory = join(testDirectory, 'dotnet');
let startAttempted = false;

try {
  if (scenarioName === 'python') {
    execute('dotnet', ['new', 'console', '--output', dotnetDirectory, '--no-restore']);
    const consoleOutput = execute('dotnet', ['run', '--project', dotnetDirectory], { capture: true });
    assert.ok(consoleOutput.includes('Hello, World!'), '.NET must restore, compile, and run a project.');
  }

  execute('aspire', [
    'new', scenario.template,
    '--name', 'DevcontainerSmoke',
    '--output', appDirectory,
    ...(scenario.cache ? ['--use-redis-cache', 'true'] : []),
    '--suppress-agent-init',
    '--non-interactive',
  ], { cwd: testDirectory });

  startAttempted = true;
  execute('aspire', ['start', '--isolated', '--non-interactive'], { cwd: appDirectory });
  for (const name of [...(scenario.cache ? ['cache'] : []), scenario.api, scenario.frontend]) {
    execute('aspire', ['wait', name, '--timeout', '180', '--non-interactive'], { cwd: appDirectory });
  }

  const description = execute('aspire', ['describe', '--format', 'Json', '--non-interactive'], {
    cwd: appDirectory,
    capture: true,
  });
  // The CLI can print a discovery message before its JSON output.
  const jsonStart = description.indexOf('{');
  assert.ok(jsonStart >= 0, 'Aspire must return a resource description.');
  const { resources } = JSON.parse(description.slice(jsonStart));
  const resource = name => {
    const result = resources.find(item => item.displayName === name);
    assert.ok(result, `Missing resource: ${name}`);
    assert.equal(result.healthStatus, 'Healthy', `${name} must be healthy.`);
    return result;
  };

  const api = resource(scenario.api);
  const frontend = resource(scenario.frontend);
  const endpoint = item => item.urls.find(url => url.url.startsWith('https:'))?.url
    ?? item.urls.find(url => url.url.startsWith('http:'))?.url;
  const apiUrl = endpoint(api);
  const frontendUrl = endpoint(frontend);
  assert.ok(apiUrl, 'The API must expose an endpoint.');
  assert.ok(frontendUrl, 'The frontend must expose an endpoint.');
  if (!withoutDotnet) {
    assert.equal(new URL(apiUrl).protocol, 'https:', 'The API smoke test must exercise HTTPS.');
  }
  if (scenario.cache) {
    assert.equal(resource('cache').resourceType, 'Container');
  }

  const get = url => execute('curl', [
    '--fail', '--silent', '--show-error', '--location', '--max-time', '30', url,
  ], { capture: true });

  assert.equal(get(new URL('/health', apiUrl).href), 'Healthy');
  const forecastPath = scenarioName === 'csharp' ? '/weatherforecast' : '/api/weatherforecast';
  const direct = JSON.parse(get(new URL(forecastPath, apiUrl).href));
  assert.equal(direct.length, 5, 'The API must return five forecasts.');
  for (const forecast of direct) {
    assert.equal(typeof forecast.temperatureC, 'number');
    assert.equal(typeof forecast.summary, 'string');
  }

  if (scenarioName === 'csharp') {
    assert.equal(api.resourceType, 'Project');
    assert.equal(frontend.resourceType, 'Project');
    assert.equal(get(new URL('/health', frontendUrl).href), 'Healthy');
    const weatherPage = get(new URL('/weather', frontendUrl).href);
    assert.ok(weatherPage.includes('<h1>Weather</h1>'), 'Blazor must render the weather page.');
    assert.equal([...weatherPage.matchAll(/<td>/g)].length, 20, 'Blazor must render all five API forecasts.');
  } else {
    assert.ok(get(frontendUrl).includes('id="root"'), 'The frontend must serve the React app.');
    const proxied = JSON.parse(get(new URL(forecastPath, frontendUrl).href));
    assert.equal(proxied.length, 5, 'The frontend must proxy requests to the API.');
  }

  if (scenarioName === 'python') {
    // Seed a non-expiring value so this checks cache hits without depending on the sample's five-second TTL.
    const cached = direct.map(forecast => ({ ...forecast, summary: 'CI cache sentinel' }));
    const result = execute('docker', [
      'exec', '-i', resource('cache').properties['container.id'],
      'sh', '-c',
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --tls --cacert /usr/lib/ssl/aspire/cert.pem --raw -x SET weatherforecast',
    ], { capture: true, input: JSON.stringify(cached) });
    assert.equal(result.trim(), 'OK', 'The test must seed Redis successfully.');
    assert.deepEqual(JSON.parse(get(new URL(forecastPath, apiUrl).href)), cached, 'The API must read Redis.');
    assert.deepEqual(JSON.parse(get(new URL(forecastPath, frontendUrl).href)), cached, 'The frontend must return cached API data.');
  }

  const dashboardStatus = execute('curl', [
    '--fail', '--silent', '--show-error', '--location', '--max-time', '30',
    '--output', '/dev/null', '--write-out', '%{http_code}',
    new URL(api.dashboardUrl).origin,
  ], { capture: true });
  assert.equal(dashboardStatus, '200', 'The dashboard must be reachable over trusted HTTPS.');
  if (withoutDotnet) {
    assertNoDotnet();
  }
} catch (error) {
  console.error(error);
  if (startAttempted) {
    const logs = spawnSync('aspire', [
      'logs', '--tail', '200', '--include-hidden', '--format', 'Json', '--non-interactive',
    ], { cwd: appDirectory, encoding: 'utf8', timeout: 30_000 });
    const logDirectory = join(homedir(), '.aspire', 'logs');
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(join(logDirectory, `smoke-${scenarioName}-resources.log`),
      [logs.stdout, logs.stderr, logs.error?.stack, `Log capture exit status: ${logs.status}`].filter(Boolean).join('\n'));
    if (logs.error || logs.status !== 0) {
      console.error('Resource log capture failed:', logs.error ?? logs.stderr);
    }
  }
  throw error;
} finally {
  if (startAttempted) {
    execute('aspire', ['stop', '--non-interactive'], { cwd: appDirectory });
  }
}

rmSync(testDirectory, { recursive: true });
console.log(`Devcontainer ${scenarioName} checks passed.`);
