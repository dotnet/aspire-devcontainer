import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

process.env.ASPIRE_CLI_TELEMETRY_OPTOUT = '1';
process.env.DOTNET_CLI_TELEMETRY_OPTOUT = '1';

function execute(command, args, { cwd = process.cwd(), capture = false } = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
  });
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

for (const command of ['node', 'npm', 'python3', 'uv', 'dotnet', 'pwsh', 'aspire']) {
  execute(command, ['--version']);
}

execute('docker', ['info', '--format', 'Docker server: {{.ServerVersion}}']);
execute('docker', ['run', '--rm', 'hello-world']);

const testDirectory = mkdtempSync(join(homedir(), '.aspire-devcontainer-test-'));
const appDirectory = join(testDirectory, 'polyglot');
const dotnetDirectory = join(testDirectory, 'dotnet');
let startAttempted = false;

try {
  execute('dotnet', ['new', 'console', '--output', dotnetDirectory, '--no-restore']);
  const consoleOutput = execute('dotnet', ['run', '--project', dotnetDirectory], { capture: true });
  assert.ok(consoleOutput.includes('Hello, World!'), '.NET must restore, compile, and run a project.');

  execute('aspire', [
    'new', 'aspire-py-starter',
    '--name', 'DevcontainerSmoke',
    '--output', appDirectory,
    '--use-redis-cache', 'true',
    '--suppress-agent-init',
    '--non-interactive',
  ], { cwd: testDirectory });

  startAttempted = true;
  execute('aspire', ['start', '--isolated', '--non-interactive'], { cwd: appDirectory });
  for (const name of ['cache', 'app', 'frontend']) {
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

  assert.equal(resource('cache').resourceType, 'Container');
  const api = resource('app');
  const frontend = resource('frontend');
  const apiUrl = api.urls.find(endpoint => endpoint.name === 'http')?.url;
  const frontendUrl = frontend.urls.find(endpoint => endpoint.name === 'http')?.url;
  assert.ok(apiUrl, 'The Python API must expose an endpoint.');
  assert.ok(frontendUrl, 'The React frontend must expose an endpoint.');
  assert.equal(new URL(apiUrl).protocol, 'https:', 'The API smoke test must exercise HTTPS.');

  const get = url => execute('curl', [
    '--fail', '--silent', '--show-error', '--max-time', '30', url,
  ], { capture: true });

  assert.equal(get(new URL('/health', apiUrl).href), 'Healthy');
  assert.ok(get(frontendUrl).includes('id="root"'), 'The frontend must serve the React app.');

  const proxied = JSON.parse(get(new URL('/api/weatherforecast', frontendUrl).href));
  const direct = JSON.parse(get(new URL('/api/weatherforecast', apiUrl).href));
  assert.equal(proxied.length, 5, 'The frontend must proxy requests to the Python API.');
  assert.deepEqual(direct, proxied, 'Redis must cache the forecast between requests.');
  for (const forecast of direct) {
    assert.equal(typeof forecast.temperatureC, 'number');
    assert.equal(typeof forecast.summary, 'string');
  }

  const dashboardStatus = execute('curl', [
    '--fail', '--silent', '--show-error', '--location', '--max-time', '30',
    '--output', '/dev/null', '--write-out', '%{http_code}',
    new URL(api.dashboardUrl).origin,
  ], { capture: true });
  assert.equal(dashboardStatus, '200', 'The dashboard must be reachable over trusted HTTPS.');
} finally {
  if (startAttempted) {
    execute('aspire', ['stop', '--non-interactive'], { cwd: appDirectory });
  }
}

rmSync(testDirectory, { recursive: true });
console.log('Devcontainer lifecycle prerequisites, tooling, HTTPS, Docker, and polyglot app checks passed.');
