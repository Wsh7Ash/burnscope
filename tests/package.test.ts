import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { VERSION } from '../src/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

interface PackageJson {
  name: string;
  version: string;
  description: string;
  license: string;
  type: string;
  engines: Record<string, string>;
  bin: Record<string, string>;
  main: string;
  types: string;
  files: string[];
  keywords: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  repository?: Record<string, string>;
}

function readPackage(): PackageJson {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageJson;
}

function readText(relative: string): string {
  return readFileSync(resolve(root, relative), 'utf8');
}

describe('package.json', () => {
  const pkg = readPackage();

  it('keeps the exported version in step with the manifest', () => {
    assert.equal(pkg.version, VERSION);
  });

  it('declares no runtime dependencies', () => {
    assert.equal(pkg.dependencies, undefined);
  });

  it('builds only TypeScript and Node type definitions', () => {
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', 'typescript']);
  });

  it('points the bin at the compiled entry point with a node shebang', () => {
    assert.deepEqual(pkg.bin, { burnscope: './dist/cli.js' });
    const cli = readText('src/cli.ts');
    assert.ok(cli.startsWith('#!/usr/bin/env node'), 'dist/cli.js must be directly executable');
  });

  it('wires main and types to the build output', () => {
    assert.equal(pkg.main, './dist/index.js');
    assert.equal(pkg.types, './dist/index.d.ts');
  });

  it('is a modern ESM package with a pinned node floor', () => {
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.engines['node'], '>=20.11');
  });

  it('is MIT licensed and the LICENSE file agrees', () => {
    assert.equal(pkg.license, 'MIT');
    assert.match(readText('LICENSE'), /MIT License/);
  });

  it('names itself burnscope and tags it for discoverability', () => {
    assert.equal(pkg.name, 'burnscope');
    for (const keyword of ['slo', 'error-budget', 'burn-rate', 'prometheus', 'sre']) {
      assert.ok(pkg.keywords.includes(keyword), `missing keyword ${keyword}`);
    }
  });

  it('ships only the build output and the licence', () => {
    assert.deepEqual(pkg.files, ['dist', 'README.md', 'LICENSE']);
  });

  it('offers the verification scripts CI relies on', () => {
    for (const script of ['build', 'typecheck', 'test', 'demo', 'verify', 'clean']) {
      assert.equal(typeof pkg.scripts[script], 'string', `missing script ${script}`);
    }
  });

  it('has a description that says what it does', () => {
    assert.match(pkg.description, /burn-rate/);
    assert.match(pkg.description, /error-budget/);
  });
});

describe('repository layout', () => {
  it('ships every document the project promises', () => {
    for (const file of [
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'RESULTS.md',
      'docs/PROJECT_SPEC.md',
      'docs/ARCHITECTURE.md',
      'docs/USAGE.md',
      '.gitignore',
    ]) {
      assert.equal(readText(file).length > 0, true, `${file} is empty`);
    }
  });

  it('has a CI workflow that runs the full verification', () => {
    const workflow = readText('.github/workflows/ci.yml');
    assert.match(workflow, /npm ci/);
    assert.match(workflow, /npm run typecheck/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /npm run demo/);
  });

  it('ignores build output and dependencies', () => {
    const ignore = readText('.gitignore');
    for (const entry of ['node_modules/', 'dist/', 'dist-test/']) {
      assert.ok(ignore.includes(entry), `missing ${entry}`);
    }
  });
});

describe('examples', () => {
  it('ships a spec and a metrics file that parse', async () => {
    const { parseSpec } = await import('../src/spec.js');
    const { parsePrometheus } = await import('../src/parse/prometheus.js');
    const spec = parseSpec(readText('examples/slo.json'));
    assert.ok(spec.slos.length > 0);
    const document = parsePrometheus(readText('examples/metrics.prom'));
    assert.ok(document.series.length > 0, 'the example metrics file must contain series');
  });
});
