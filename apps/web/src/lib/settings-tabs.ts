/** Tabs of the admin settings (URL based: reloads and shared links keep the tab). */
export const SETTINGS_TABS = [
  'general',
  'appearance',
  'organizer',
  'checkout',
  'payments',
  'invoicing',
  'email',
  'wallet',
  'accounts',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
