/**
 * Pages of the admin settings (URL based: reloads and shared links keep the page).
 * One page = one topic (usually one card), grouped in the settings side menu.
 * Keys `appearance` (branding), `payments` (bank transfer), `email` (SMTP), `wallet` (intro + design)
 * and `accounts` (customer accounts) keep their historical URLs.
 */
export const SETTINGS_TAB_GROUPS = [
  { group: 'shop', tabs: ['general', 'organizer', 'seo', 'cookies'] },
  { group: 'design', tabs: ['appearance', 'startPage', 'shopLayout', 'sponsors', 'seatDisplay'] },
  { group: 'sales', tabs: ['checkout', 'waitlist', 'accounts', 'selfService'] },
  { group: 'payment', tabs: ['payments', 'invoicing'] },
  { group: 'communication', tabs: ['email', 'emailHeader', 'notifications'] },
  { group: 'tickets', tabs: ['wallet', 'walletApple', 'walletGoogle', 'scanner'] },
  { group: 'system', tabs: ['security', 'monitoring'] },
] as const;

/** Valid pages: the menu pages plus `paypal` (reached from the Finance section of the admin menu). */
export const SETTINGS_TABS = [...SETTINGS_TAB_GROUPS.flatMap((g) => g.tabs), 'paypal' as const];
export type SettingsTab = (typeof SETTINGS_TABS)[number];
