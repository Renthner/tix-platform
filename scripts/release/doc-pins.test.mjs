// node --test scripts/release
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDocPins, hasPreReleaseWording, rewriteDocPins } from './doc-pins.mjs';

const fixture = [
  '> **Status:** pre-release (`1.0.0-alpha.3`). Feature-complete.',
  '```bash',
  'export TIX_VERSION=1.0.0-alpha.3',
  'curl -fLO https://example.test/v$TIX_VERSION/docker-compose.yml',
  '```',
  '| `1.0.0-alpha.3`, `1.0.0` | exactly this version |',
  'Set TIX_CHANNEL=next (or such as `1.0.0-alpha.3`)',
  '',
].join('\n');

test('rewrites only TIX_VERSION assignments and the status line', () => {
  const out = rewriteDocPins(fixture, '1.0.0-beta.1');
  assert.deepEqual(findDocPins(out), ['1.0.0-beta.1', '1.0.0-beta.1']);
  assert.match(out, /^> \*\*Status:\*\* pre-release \(`1\.0\.0-beta\.1`\)\. Feature-complete\.$/m);
  assert.match(out, /^export TIX_VERSION=1\.0\.0-beta\.1$/m);
  assert.match(out, /v\$TIX_VERSION\/docker-compose\.yml/);
  assert.match(out, /^\| `1\.0\.0-alpha\.3`, `1\.0\.0` \|/m);
  assert.match(out, /such as `1\.0\.0-alpha\.3`/);
});

test('rewrite is idempotent and finds pins', () => {
  assert.deepEqual(findDocPins(fixture), ['1.0.0-alpha.3', '1.0.0-alpha.3']);
  const once = rewriteDocPins(fixture, '2.0.0');
  assert.equal(rewriteDocPins(once, '2.0.0'), once);
});

test('detects pre-release status wording per file', () => {
  assert.equal(hasPreReleaseWording('README.md', fixture), true);
  assert.equal(hasPreReleaseWording('README.md', '> **Status:** stable (`1.0.0`).'), false);
  assert.equal(
    hasPreReleaseWording('README.de.md', '> **Status:** Vorabversion (`1.0.0-rc.1`).'),
    true,
  );
  assert.equal(hasPreReleaseWording('README.de.md', '> **Status:** stabil (`1.0.0`).'), false);
  assert.equal(
    hasPreReleaseWording('docs/INSTALL.md', '> TIX is currently a pre-release (x)'),
    true,
  );
  assert.equal(
    hasPreReleaseWording('docs/INSTALL.de.md', '> TIX ist derzeit eine Vorabversion (x)'),
    true,
  );
  assert.equal(hasPreReleaseWording('CHANGELOG.md', 'pre-release'), false);
});
