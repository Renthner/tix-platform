// Pure helpers for deploy-bundle.mjs: embed config files into the deploy compose template and
// translate redis.conf into command-line flags. No file or process access, so they are unit-tested.

// Compose interpolates `$VAR` / `${VAR}` inside `configs: content:`; `$$` yields a literal `$`.
export function escapeCompose(text) {
  return text.replaceAll('$', '$$$$');
}

// Content of a literal block scalar (`key: |`): every line indented, `$` escaped, blank lines kept
// empty, no trailing newline (the template's next line supplies it; YAML clip keeps exactly one).
// Content that starts with whitespace would need an explicit indentation indicator, which no config
// file here uses - refuse instead of corrupting.
export function yamlBlock(text, indent) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (/^\s/.test(lines[0])) {
    throw new Error('embedded file must not start with whitespace (YAML block scalar)');
  }
  const pad = ' '.repeat(indent);
  return lines.map((l) => (l === '' ? '' : pad + escapeCompose(l))).join('\n');
}

// Replaces each marker line (`      __NAME__`, alone on its line) of the template by the block.
export function embedFiles(template, files) {
  let out = template;
  for (const [marker, text] of Object.entries(files)) {
    const re = new RegExp(`^([ ]+)${marker}[ ]*$`, 'm');
    const m = re.exec(out);
    if (!m) throw new Error(`deploy compose template lacks the marker ${marker}`);
    out = out.replace(re, () => yamlBlock(text, m[1].length));
  }
  return out;
}

// redis.conf -> [['--bind', '0.0.0.0'], ['--save', '900', '1', ...], ...] (one entry per directive).
export function redisDirectives(conf) {
  return conf
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [name, ...values] = l.split(/\s+/);
      return [`--${name}`, ...values];
    });
}

// Directives (as "--flag v1 v2") whose flag is missing from `command` or not followed by its values.
export function missingDirectives(command, directives) {
  const missing = [];
  for (const d of directives) {
    const i = command.indexOf(d[0]);
    const ok = i >= 0 && d.every((v, n) => command[i + n] === v);
    if (!ok) missing.push(d.join(' '));
  }
  return missing;
}
