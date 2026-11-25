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
  '| `1.0.0-alpha.3` | exactly this version |',
  './tix-update.sh 1.0.0-alpha.3  # or one exact version',
  './tix-update.sh stable',
  'Set TIX_CHANNEL=next (or such as `1.0.0-alpha.3`)',
  '',
].join('\n');

test('rewrites TIX_VERSION assignments, the status line and the version examples', () => {
  const out = rewriteDocPins(fixture, '1.0.0-beta.1');
  assert.deepEqual(findDocPins(out), Array(5).fill('1.0.0-beta.1'));
  assert.match(out, /^> \*\*Status:\*\* pre-release \(`1\.0\.0-beta\.1`\)\. Feature-complete\.$/m);
  assert.match(out, /^export TIX_VERSION=1\.0\.0-beta\.1$/m);
  assert.match(out, /v\$TIX_VERSION\/docker-compose\.yml/);
  assert.match(out, /^\| \`1\.0\.0-beta\.1\` \|/m);
  assert.match(out, /such as \`1\.0\.0-beta\.1\`/);
  assert.match(out, /^\.\/tix-update\.sh 1\.0\.0-beta\.1 {2}#/m);
  assert.match(out, /^\.\/tix-update\.sh stable$/m);
});

test('rewrite is idempotent and finds pins', () => {
  assert.deepEqual(findDocPins(fixture), Array(5).fill('1.0.0-alpha.3'));
  const once = rewriteDocPins(fixture, '2.0.0');
  assert.equal(rewriteDocPins(once, '2.0.0'), once);
});

test('detects pre-release status wording per file', () => {
  assert.equal(hasPreReleaseWording('README.md', fixture), true);
  assert.equal(hasPreReleaseWording('README.md', '> **Status:** stable (`1.0.0`).'), false);
  assert.equal(
    hasPreReleaseWording('docs/de/README.md', '> **Status:** Vorabversion (`1.0.0-rc.1`).'),
    true,
  );
  assert.equal(hasPreReleaseWording('docs/de/README.md', '> **Status:** stabil (`1.0.0`).'), false);
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
