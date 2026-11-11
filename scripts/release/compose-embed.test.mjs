// node --test scripts/release
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  embedFiles,
  escapeCompose,
  missingDirectives,
  redisDirectives,
  yamlBlock,
} from './compose-embed.mjs';

const repo = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('escapeCompose doubles every dollar sign', () => {
  assert.equal(
    escapeCompose('{$SITE_ADDRESS::80} ${A:?x} $B $$C'),
    '{$$SITE_ADDRESS::80} $${A:?x} $$B $$$$C',
  );
  assert.equal(escapeCompose('no dollars'), 'no dollars');
});

test('yamlBlock indents, keeps blank lines empty and drops trailing newlines', () => {
  assert.equal(yamlBlock('#!/bin/sh\n\n\tx "$A"\n\n', 6), '      #!/bin/sh\n\n      \tx "$$A"');
  assert.equal(yamlBlock('a\r\nb\r\n', 2), '  a\n  b');
  assert.throws(() => yamlBlock('  indented first line\n', 2));
});

test('embedFiles replaces marker lines with the matching indentation', () => {
  const tpl =
    'configs:\n  a:\n    content: |\n      __A__\n  b:\n    content: |\n      __B__\nend: 1\n';
  assert.equal(
    embedFiles(tpl, { __A__: 'x $y\n\nz\n', __B__: 'q' }),
    'configs:\n  a:\n    content: |\n      x $$y\n\n      z\n  b:\n    content: |\n      q\nend: 1\n',
  );
  assert.throws(() => embedFiles(tpl, { __C__: 'x' }));
});

test('redisDirectives skips comments and keeps multi-value directives', () => {
  const dirs = redisDirectives('# c\n\nbind 0.0.0.0\nsave 900 1 300 100\n');
  assert.deepEqual(dirs, [
    ['--bind', '0.0.0.0'],
    ['--save', '900', '1', '300', '100'],
  ]);
  assert.deepEqual(
    missingDirectives(['redis-server', '--bind', '0.0.0.0', '--save', '900'], dirs),
    ['--save 900 1 300 100'],
  );
});

test('every dollar of the real config files is escaped in the block', () => {
  for (const f of ['docker/caddy/Caddyfile', 'docker/minio/init.sh']) {
    const source = repo(f);
    const block = yamlBlock(source, 6);
    assert.ok(source.includes('$'), `${f} contains variables`);
    assert.equal(block.replaceAll('$$', '').includes('$'), false, f);
    assert.equal(block.replaceAll('$$', '$').replace(/^ {6}/gm, ''), source.replace(/\n+$/, ''));
  }
});
