// Version pins in the install docs (kept current by set-version.mjs, verified by --check).
// Only `TIX_VERSION=<v>` assignments and the "> **Status:** ... (`<v>`)" line are pins;
// the changelog, tag tables and other historical mentions are left alone.
export const DOC_PIN_FILES = ['README.md', 'README.de.md', 'docs/INSTALL.md', 'docs/INSTALL.de.md'];

const ASSIGN = /^(\s*(?:export\s+)?TIX_VERSION=)\S+/gm;
const STATUS = /^(> \*\*Status:\*\*[^`\n]*`)[^`\n]+(`)/gm;

export function rewriteDocPins(text, version) {
  return text.replace(ASSIGN, `$1${version}`).replace(STATUS, `$1${version}$2`);
}

/** All versions currently pinned in the text (in document order). */
export function findDocPins(text) {
  const out = [];
  for (const m of text.matchAll(ASSIGN)) out.push(m[0].replace(/^[^=]*=/, ''));
  for (const m of text.matchAll(STATUS)) out.push(m[0].replace(/^[^`]*`/, '').replace(/`$/, ''));
  return out;
}

const PRE_RELEASE_WORDING = {
  'README.md': /^> \*\*Status:\*\*[^\n]*pre-release/im,
  'README.de.md': /^> \*\*Status:\*\*[^\n]*Vorabversion/im,
  'docs/INSTALL.md': /^> TIX is currently a pre-release/im,
  'docs/INSTALL.de.md': /^> TIX ist derzeit eine Vorabversion/im,
};

/** True when the doc still carries the pre-release status wording (a stable release must drop it). */
export function hasPreReleaseWording(path, text) {
  const re = PRE_RELEASE_WORDING[path];
  return re ? re.test(text) : false;
}
