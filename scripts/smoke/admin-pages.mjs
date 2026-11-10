// Read-only page smoke test against a running stack: signs in to the admin, GETs every admin
// page (both locales) and the public shop pages, and reports non-200 responses, Next.js error
// pages and raw message keys ("MISSING_MESSAGE" leftovers like "translations.tab.title").
//
// Usage:
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/smoke/admin-pages.mjs [admin|shop|all] [baseUrl]
//   (baseUrl defaults to BASE_URL or http://localhost:8080; mode defaults to "all")
//
// Only GET requests are sent – except the single sign-in form POST of the admin login. Accounts
// with two-factor authentication are not supported (the script fails with a clear message).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const mode = ['admin', 'shop', 'all'].includes(process.argv[2]) ? process.argv[2] : 'all';
const base = (
  process.argv.find((a, i) => i >= 2 && /^https?:\/\//.test(a)) ??
  process.env.BASE_URL ??
  'http://localhost:8080'
).replace(/\/$/, '');
const LOCALES = [
  { code: 'en', prefix: '' },
  { code: 'de', prefix: '/de' },
];
const adminDir = join(
  import.meta.dirname,
  '..',
  '..',
  'apps',
  'web',
  'src',
  'app',
  '[locale]',
  'admin',
  '(panel)',
);

const KEY_NAMESPACES =
  'admin|orders|translations|customers|backups|accounting|banking|fees|emailTemplates|ticketDesigner|adminSecurity|editor|common|checkout|shop|account|mail|cart|queue';
// Dotted keys of known namespaces; not preceded by a word char, "@", "/", "." or "-" (URLs, mails).
const RAW_KEY = new RegExp(
  `(?<![\\w@/.\\-])(?:${KEY_NAMESPACES})\\.[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+\\b`,
  'g',
);
const ERROR_MARKERS = [
  'id="__next_error__"',
  'Application error: a server-side exception',
  'This page couldn’t load',
  "This page couldn't load",
  'Internal Server Error',
  'This page could not be found',
  'MISSING_MESSAGE',
  'Attempted to call',
];

// ───────────────────────────── HTTP with a cookie jar ─────────────────────────────
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function storeCookies(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1);
    if (/;\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(c) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

/** GET with manual redirect handling (cookies kept). Returns the final response. */
async function get(path, { maxRedirects = 5 } = {}) {
  let url = path.startsWith('http') ? path : base + path;
  const chain = [];
  for (let i = 0; i <= maxRedirects; i += 1) {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { cookie: cookieHeader(), accept: 'text/html' },
    });
    storeCookies(res);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      chain.push(new URL(url).pathname);
      continue;
    }
    return { status: res.status, html: await res.text(), finalPath: new URL(url).pathname, chain };
  }
  return { status: 599, html: '', finalPath: new URL(url).pathname, chain: [...chain, '…loop'] };
}

const decode = (s) =>
  s
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

// ───────────────────────────── sign-in ─────────────────────────────
async function signIn() {
  // A pre-created session (e.g. a short-lived row for a throwaway test admin) skips the form login.
  if (process.env.ADMIN_SESSION_TOKEN) {
    jar.set('tix_admin', process.env.ADMIN_SESSION_TOKEN);
    return;
  }
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (admin without two-factor).');
  }
  const page = await get('/admin/login');
  if (page.status !== 200) throw new Error(`/admin/login answered ${page.status}`);
  // The sign-in form is a server action form: submit it like a browser without JavaScript does
  // (multipart POST to the page itself, hidden $ACTION_* fields included).
  const form = [...page.html.matchAll(/<form\b[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((f) => /name="password"/.test(f));
  if (!form) throw new Error('Sign-in form not found on /admin/login');
  const body = new FormData();
  for (const m of form.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    if (!/type="hidden"/.test(tag)) continue;
    const name = /name="([^"]*)"/.exec(tag)?.[1];
    const value = /value="([^"]*)"/.exec(tag)?.[1] ?? '';
    if (name) body.append(decode(name), decode(value));
  }
  body.set('email', email);
  body.set('password', password);
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookieHeader() },
    body,
  });
  storeCookies(res);
  const text = res.status === 200 ? await res.text() : '';
  if (/name="code"/.test(text) || (jar.has('tix_admin_pending') && res.status === 200)) {
    throw new Error('This admin account requires two-factor authentication – not supported.');
  }
  const check = await get('/admin');
  if (check.status !== 200 || check.finalPath.includes('/login')) {
    throw new Error(
      `Sign-in failed (POST ${res.status}; /admin ended at ${check.finalPath}). Wrong credentials, ` +
        'locked account, rate limit, or two-factor authentication.',
    );
  }
}

// ───────────────────────────── route discovery ─────────────────────────────
/** Route templates like ["events", "[id]", "pricing"] for every page.tsx below the (panel) group. */
function discoverTemplates(dir = adminDir, trail = []) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      const segment = /^\(.*\)$/.test(name) ? null : name; // route groups are invisible
      out.push(...discoverTemplates(full, segment ? [...trail, segment] : trail));
    } else if (name === 'page.tsx') {
      out.push(trail);
    }
  }
  return out;
}

const isDynamic = (s) => /^\[.+\]$/.test(s);
const staticSiblings = (templates, prefix) =>
  new Set(
    templates
      .filter((t) => t.length > prefix.length && prefix.every((s, i) => t[i] === s))
      .map((t) => t[prefix.length])
      .filter((s) => !isDynamic(s)),
  );

/** Resolves dynamic segments to real values by reading links of the parent list pages. */
async function expandTemplates(templates) {
  const resolved = new Map(); // "events/[id]" prefix → [values]
  async function valuesFor(prefixSegments) {
    // prefixSegments end with a dynamic segment; the parent is everything before it (real values)
    const key = prefixSegments.join('/');
    if (resolved.has(key)) return resolved.get(key);
    const parent = prefixSegments.slice(0, -1);
    const param = prefixSegments.at(-1);
    const parentRealPaths = await expandPrefix(parent);
    const found = new Set();
    for (const real of parentRealPaths) {
      const page = await get(`/admin/${real.join('/')}`.replace(/\/$/, ''));
      if (page.status !== 200) continue;
      const templatePrefix = parent;
      const skip = staticSiblings(templates, templatePrefix);
      const re = new RegExp(
        `href="(?:/de)?/admin/${real.map(escapeRe).join('/')}${real.length ? '/' : ''}([^"/?#]+)`,
        'g',
      );
      const values = [];
      for (const m of page.html.matchAll(re)) {
        const v = decodeURIComponent(m[1]);
        if (!skip.has(v) && !values.includes(v)) values.push(v);
      }
      // Ids: one sample is enough; tabs and other enumerations: all of them.
      const take = param === '[tab]' ? values.slice(0, 20) : values.slice(0, 1);
      take.forEach((v) => found.add(v));
    }
    const list = [...found];
    resolved.set(key, list);
    return list;
  }
  async function expandPrefix(prefix) {
    let results = [[]];
    for (let i = 0; i < prefix.length; i += 1) {
      const seg = prefix[i];
      if (!isDynamic(seg)) {
        results = results.map((r) => [...r, seg]);
      } else {
        // Resolve based on the already expanded parent (first expansion only, to stay small).
        const vals = await valuesFor(prefix.slice(0, i + 1));
        results = results.flatMap((r) => vals.map((v) => [...r, v]));
      }
    }
    return results;
  }
  const routes = new Map(); // path → template label
  const unresolved = [];
  for (const t of templates) {
    const expanded = await expandPrefix(t);
    if (expanded.length === 0) unresolved.push(`/admin/${t.join('/')}`);
    for (const r of expanded) routes.set(`/admin${r.length ? `/${r.join('/')}` : ''}`, t.join('/'));
  }
  return { routes, unresolved };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ───────────────────────────── page checks ─────────────────────────────
const problems = [];
let checked = 0;

function visibleHtml(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

async function checkPage(path, { expectAuth = false } = {}) {
  checked += 1;
  let res;
  try {
    res = await get(path);
  } catch (err) {
    problems.push(`${path}: request failed – ${err instanceof Error ? err.message : err}`);
    return res;
  }
  const label = res.chain.length ? `${path} (→ ${res.finalPath})` : path;
  if (res.status !== 200) problems.push(`${label}: HTTP ${res.status}`);
  if (expectAuth && res.finalPath.includes('/login')) {
    problems.push(`${label}: redirected to the login page (session lost?)`);
  }
  // Markers only count in rendered markup: the RSC payload always carries the not-found template.
  const visible = visibleHtml(res.html);
  for (const marker of ERROR_MARKERS) {
    if (visible.includes(marker)) problems.push(`${label}: error marker "${marker}"`);
  }
  const keys = [...new Set(visible.match(RAW_KEY) ?? [])];
  if (keys.length > 0) {
    problems.push(
      `${label}: raw message keys: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}`,
    );
  }
  return res;
}

async function runAdmin() {
  await signIn();
  console.log(`Signed in at ${base}`);
  const templates = discoverTemplates();
  const { routes, unresolved } = await expandTemplates(templates);
  for (const u of unresolved) console.log(`  (skipped, no sample id found: ${u})`);
  console.log(`Admin: ${routes.size} pages × ${LOCALES.length} locales`);
  for (const path of [...routes.keys()].sort()) {
    for (const { prefix } of LOCALES) await checkPage(`${prefix}${path}`, { expectAuth: true });
  }
}

async function runShop() {
  jar.clear(); // anonymous visitor
  const home = await get('/');
  const slugs = [
    ...new Set(
      [...home.html.matchAll(/href="(?:\/de)?\/events\/([^"/?#]+)"/g)].map((m) =>
        decodeURIComponent(m[1]),
      ),
    ),
  ].slice(0, 5);
  const paths = ['/', '/account/login', '/cart', ...slugs.map((s) => `/events/${s}`)];
  console.log(`Shop: ${paths.length} pages × ${LOCALES.length} locales`);
  for (const path of paths) {
    for (const { prefix } of LOCALES)
      await checkPage(path === '/' ? prefix || '/' : `${prefix}${path}`);
  }
}

try {
  if (mode === 'admin' || mode === 'all') await runAdmin();
  if (mode === 'shop' || mode === 'all') await runShop();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}

console.log(`\nChecked ${checked} page loads.`);
if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log('✓ no problems found');
