import { getMessages } from 'next-intl/server';
import { SETTINGS_TABS, type SettingsTab } from '@/lib/settings-tabs';

/** Message paths whose texts (field labels, titles) make a settings page findable. */
const SOURCES: Record<SettingsTab, readonly (readonly string[])[]> = {
  general: [['admin', 'settings', 'general']],
  organizer: [['admin', 'settings', 'organizer']],
  seo: [['admin', 'settings', 'seo']],
  cookies: [['admin', 'settings', 'cookieNotice']],
  appearance: [['admin', 'settings', 'branding']],
  startPage: [['admin', 'settings', 'startPage']],
  shopLayout: [['admin', 'settings', 'shopLayout']],
  sponsors: [['admin', 'settings', 'sponsors']],
  seatDisplay: [['admin', 'settings', 'seatDisplay']],
  checkout: [['admin', 'settings', 'checkout']],
  waitlist: [['admin', 'settings', 'waitlist']],
  accounts: [['admin', 'settings', 'customerAccounts']],
  selfService: [['admin', 'settings', 'ticketSelfService']],
  payments: [['admin', 'settings', 'bankTransfer']],
  paypal: [['admin', 'settings', 'paypal']],
  invoicing: [['admin', 'settings', 'invoicing']],
  email: [['admin', 'settings', 'smtp']],
  emailHeader: [['admin', 'settings', 'emailHeader']],
  notifications: [['system', 'alerts', 'settings']],
  wallet: [
    ['admin', 'wallet', 'title'],
    ['admin', 'wallet', 'design'],
  ],
  walletApple: [['admin', 'wallet', 'apple']],
  walletGoogle: [['admin', 'wallet', 'google']],
  scanner: [['adminSecurity', 'settings', 'scanner']],
  security: [['adminSecurity', 'settings', 'security']],
  monitoring: [['system', 'security']],
};

/** Longest text kept in the index: field labels and short titles; long hints/guides are skipped. */
const MAX_LEN = 80;

function collect(node: unknown, out: string[], depth = 0): void {
  if (typeof node === 'string') {
    if (node.length <= MAX_LEN && !node.includes('{') && !node.includes('<')) out.push(node);
  } else if (node && typeof node === 'object' && depth < 5) {
    for (const [key, value] of Object.entries(node)) {
      if (/(Hint|description|intro|steps)$/i.test(key)) continue;
      collect(value, out, depth + 1);
    }
  }
}

function at(messages: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
    messages,
  );
}

/** Searchable texts per settings page for the current locale (labels of the fields on that page). */
export async function buildSettingsSearchIndex(): Promise<Record<string, string[]>> {
  const messages = await getMessages();
  const index: Record<string, string[]> = {};
  for (const tab of SETTINGS_TABS) {
    const texts: string[] = [];
    for (const path of SOURCES[tab]) collect(at(messages, path), texts);
    index[tab] = [...new Set(texts)];
  }
  return index;
}
