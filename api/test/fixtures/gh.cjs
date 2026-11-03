#!/usr/bin/env node
// Deterministic CLI boundary for tests only. Never included in the runtime image.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const token = 'fixture-only-github-token';
const identities = { 'fixture-token-a': { login: 'developer-a', id: 101 }, 'fixture-token-b': { login: 'developer-b', id: 202 }, [token]: { login: 'fixture-operator', id: 123 } };
const root = process.env.GOND_AGENT_GH_FIXTURE_DIR;
if (args[0] === 'auth' && args[1] === 'login') {
  const old = root && fs.existsSync(path.join(root, 'old'));
  if (args.includes('--help')) { console.log('Usage: gh auth login --web' + (old ? '' : ' --insecure-storage')); process.exit(0); }
  if (args.includes('--insecure-storage') === !!old) process.exit(2);
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || !root) process.exit(2);
  process.stderr.write('! First copy your one-time co');
  setTimeout(() => process.stderr.write('de: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n'), 30);
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(root, 'fail'))) { console.error('sensitive-upstream-response'); process.exit(1); }
    if (!fs.existsSync(path.join(root, 'approve'))) return;
    fs.writeFileSync(path.join(process.env.GH_CONFIG_DIR, 'fixture-token'), token, { mode: 0o600 });
    clearInterval(timer);
    process.exit(0);
  }, 50);
} else if (args[0] === 'auth' && args[1] === 'token') {
  process.stdout.write(fs.readFileSync(path.join(process.env.GH_CONFIG_DIR, 'fixture-token'), 'utf8'));
} else if (args[0] === 'api') {
  const identity = identities[process.env.GH_TOKEN];
  if (!identity) process.exit(1);
  if (root) fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({ endpoint: args[1], login: identity.login }) + '\n');
  const endpoint = args[1];
  const result = endpoint === 'user' ? identity : endpoint.startsWith('user/repos') ? [{ full_name: process.env.GH_TOKEN === token ? 'acme/app' : identity.login + '/app', private: true, default_branch: 'main', pushed_at: null }] : endpoint.includes('/branches') ? [{ name: 'main' }] : endpoint === 'graphql' ? { data: { p0: { pullRequest: { state: 'OPEN' } } } } : endpoint.endsWith('/pulls') ? { number: 42, html_url: 'https://github.com/' + identity.login + '/app/pull/42' } : { default_branch: 'main' };
  process.stdout.write(JSON.stringify(result));
} else { process.exit(2); }
