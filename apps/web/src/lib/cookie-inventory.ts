/**
 * Every cookie the web app sets. This is a technical fact (not operator configuration) and the
 * single source for the shop page "/cookies"; purpose and lifetime texts live in the
 * `shop.cookies.items.<key>` messages. All of them are strictly necessary (§ 25 (2) TTDSG), so
 * the cookie notice only informs, it does not ask for consent.
 *
 * Keep this list in sync when a new cookie is introduced.
 */

import { THEME_COOKIE } from './theme';

/** Remembers that the information notice was dismissed. */
export const COOKIE_NOTICE_COOKIE = 'tix_cookie_notice';
/** Dismissal is remembered for one year. */
export const COOKIE_NOTICE_MAX_AGE_SECONDS = 365 * 24 * 3600;

export type CookieKey =
  | 'session'
  | 'queuePass'
  | 'customer'
  | 'locale'
  | 'theme'
  | 'notice'
  | 'admin'
  | 'adminTwoFactor'
  | 'editLocale'
  | 'setupCollapsed'
  | 'queueTest';

export interface CookieInfo {
  /** Message key below `shop.cookies.items`. */
  key: CookieKey;
  /** Cookie name as sent by the browser (`…` marks a variable part). */
  name: string;
  /** `shop` cookies are set for every visitor; `staff` only after signing in to the back office. */
  scope: 'shop' | 'staff';
}

export const COOKIE_INVENTORY: readonly CookieInfo[] = [
  { key: 'session', name: 'tix_sid', scope: 'shop' },
  { key: 'queuePass', name: 'tix_qp_…', scope: 'shop' },
  { key: 'customer', name: 'tix_customer', scope: 'shop' },
  { key: 'locale', name: 'tix_locale', scope: 'shop' },
  { key: 'theme', name: THEME_COOKIE, scope: 'shop' },
  { key: 'notice', name: COOKIE_NOTICE_COOKIE, scope: 'shop' },
  { key: 'admin', name: 'tix_admin', scope: 'staff' },
  { key: 'adminTwoFactor', name: 'tix_admin_2fa', scope: 'staff' },
  { key: 'editLocale', name: 'tix_edit_locale', scope: 'staff' },
  { key: 'setupCollapsed', name: 'tix_setup_collapsed', scope: 'staff' },
  { key: 'queueTest', name: 'tix_admin_queue_test', scope: 'staff' },
];
