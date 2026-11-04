const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { dependencies } = require('./package.json');

const modules = join(__dirname, 'node_modules');
const tsdk = join(modules, 'typescript', 'lib');
const cli = join(modules, 'typescript-language-server', 'lib', 'cli.mjs');
const run = (file, args) => execFileSync(process.execPath, [file, ...args], {
  encoding: 'utf8',
  timeout: 10_000,
}).trim();

test('pinned language server CLI starts and supports stdio', () => {
  const installed = JSON.parse(readFileSync(join(modules, 'typescript-language-server', 'package.json'), 'utf8'));
  assert.equal(installed.version, dependencies['typescript-language-server']);
  assert.equal(run(cli, ['--version']), installed.version);
  assert.match(run(cli, ['--help']), /--stdio/);
  console.log(`typescript-language-server: ${installed.version}`);
});

test('pinned TypeScript SDK includes tsserver and a working compiler', () => {
  const ts = require(join(tsdk, 'typescript.js'));
  assert.equal(ts.version, dependencies.typescript);
  for (const file of ['tsserver.js', 'lib.d.ts']) {
    assert.ok(statSync(join(tsdk, file)).isFile(), `missing SDK file: ${file}`);
  }
  assert.equal(run(join(tsdk, 'tsc.js'), ['--version']), `Version ${ts.version}`);
  console.log(`TypeScript: ${ts.version}; tsdk: ${tsdk}`);
});
