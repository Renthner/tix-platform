// Static i18n usage checks (run via `pnpm --filter @tix/web test`):
//  1. every namespace used by a client component (useTranslations) reachable from a route group is
//     passed to the client provider of that group (pickMessages list in its layout) – otherwise the
//     browser shows raw keys ("MISSING_MESSAGE");
//  2. every literal key used via t('…') / t.rich / t.has / t.raw exists in the English catalogue.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const webRoot = join(import.meta.dirname, '..');
const src = join(webRoot, 'src');
const localeApp = join(src, 'app', '[locale]');

// ---------- catalogue ----------
const catalogue = new Map();
const enDir = join(webRoot, 'messages', 'en');
function flatten(obj, prefix, out) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, out);
    else out.set(path, true);
  }
}
for (const file of readdirSync(enDir)) {
  const ns = file.replace(/\.json$/, '');
  flatten(JSON.parse(readFileSync(join(enDir, file), 'utf8')), ns, catalogue);
}
const hasKey = (full) =>
  catalogue.has(full) || [...catalogue.keys()].some((k) => k.startsWith(`${full}.`));

// ---------- files ----------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(p);
  }
  return out;
}
const files = walk(src);
const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const isClient = (f) =>
  /^\s*(\/\*[\s\S]*?\*\/\s*|\/\/.*\n\s*)*['"]use client['"]/.test(text.get(f));

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith('@/')) base = join(src, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (text.has(cand)) return cand;
  }
  return null;
}
function importsOf(f) {
  const out = [];
  for (const m of text.get(f).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const r = resolveImport(f, m[1]);
    if (r) out.push(r);
  }
  return out;
}

// ---------- translation usage per file ----------
const rel = (f) => relative(webRoot, f).split(String.fromCharCode(92)).join('/');
function usageOf(f) {
  const code = text.get(f);
  const decls = [];
  for (const m of code.matchAll(
    /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*(?:['"]([^'"]*)['"])?\s*\)/g,
  )) {
    decls.push({ name: m[1], ns: m[2] ?? '', index: m.index });
  }
  for (const m of code.matchAll(
    /(\w+)\s*:\s*ReturnType<typeof useTranslations<['"]([^'"]*)['"]>>/g,
  )) {
    decls.push({ name: m[1], ns: m[2], index: m.index });
  }
  decls.sort((a, b) => a.index - b.index);
  const namespaces = new Set(decls.map((d) => d.ns).filter(Boolean));
  const keys = [];
  for (const m of code.matchAll(/\b(\w+)(?:\.(?:rich|has|raw|markup))?\(\s*(['"])([^'"\n]+)\2/g)) {
    const decl = [...decls].reverse().find((d) => d.name === m[1] && d.index < m.index);
    if (!decl) continue;
    const prefix = code.slice(Math.max(0, m.index - 1), m.index);
    if (prefix === '.') continue; // member call on another object
    keys.push({ full: decl.ns ? `${decl.ns}.${m[3]}` : m[3], decl });
  }
  return { namespaces, keys };
}

// ---------- providers ----------
function pickList(file) {
  const m = /pickMessages\(\s*\[([^\]]*)\]/.exec(text.get(file));
  if (!m) throw new Error(`no pickMessages list in ${rel(file)}`);
  return new Set([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
}
const under = (dir) => files.filter((f) => f.startsWith(dir));
const authEntries = ['admin/login/page.tsx', 'admin/forgot-password/page.tsx'].map((p) =>
  join(localeApp, p),
);
const groups = [
  {
    name: 'admin panel',
    provider: join(localeApp, 'admin', '(panel)', 'layout.tsx'),
    entries: [
      ...under(join(localeApp, 'admin', '(panel)')),
      ...under(join(src, 'components', 'admin')).filter(
        (f) => !f.includes(`${join('components', 'admin', 'auth')}`),
      ),
    ],
  },
  {
    name: 'shop',
    provider: join(localeApp, '(shop)', 'layout.tsx'),
    entries: under(join(localeApp, '(shop)')),
  },
  ...authEntries.map((e) => ({ name: rel(e), provider: e, entries: [e] })),
  {
    name: 'admin set-password pages',
    provider: join(src, 'components', 'admin', 'auth', 'set-password-page.tsx'),
    entries: [join(src, 'components', 'admin', 'auth', 'set-password-page.tsx')],
  },
];

let errors = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  errors += 1;
};

for (const group of groups) {
  if (!existsSync(group.provider)) continue;
  const allowed = pickList(group.provider);
  const seen = new Set();
  const stack = group.entries.map((f) => ({ f, client: isClient(f) }));
  const missing = new Map(); // namespace -> files
  while (stack.length) {
    const { f, client } = stack.pop();
    const stateKey = `${f}|${client}`;
    if (seen.has(stateKey)) continue;
    seen.add(stateKey);
    if (client) {
      for (const ns of usageOf(f).namespaces) {
        if (![...allowed].some((a) => ns === a || ns.startsWith(`${a}.`))) {
          if (!missing.has(ns)) missing.set(ns, new Set());
          missing.get(ns).add(rel(f));
        }
      }
    }
    for (const imp of importsOf(f)) stack.push({ f: imp, client: client || isClient(imp) });
  }
  for (const [ns, list] of missing) {
    fail(
      `namespace "${ns}" is used by client components in the ${group.name} group but missing in ` +
        `pickMessages of ${rel(group.provider)}: ${[...list].slice(0, 4).join(', ')}${list.size > 4 ? ', …' : ''}`,
    );
  }
}

// no nested providers that would replace the parent's messages
for (const f of files) {
  if (!text.get(f).includes('<NextIntlClientProvider') || !text.get(f).includes('pickMessages'))
    continue;
  const ok = [
    join(localeApp, 'layout.tsx'),
    join(localeApp, '(shop)', 'layout.tsx'),
    join(localeApp, 'admin', '(panel)', 'layout.tsx'),
    ...authEntries,
    join(src, 'components', 'admin', 'auth', 'set-password-page.tsx'),
  ];
  if (!ok.includes(f)) fail(`${rel(f)} nests a NextIntlClientProvider (replaces parent messages)`);
}

// literal keys exist
for (const f of files) {
  if (!isClient(f)) continue;
  const { keys } = usageOf(f);
  for (const { full } of keys) {
    if (!hasKey(full)) fail(`${rel(f)}: key "${full}" not in messages/en`);
  }
}

if (errors > 0) {
  console.error(`\n${errors} i18n usage problem(s) found.`);
  process.exit(1);
}
console.log('✓ i18n usage consistent (providers + literal keys)');
