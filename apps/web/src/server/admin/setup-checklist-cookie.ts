/**
 * Cookie remembering (per browser) that the "first steps" card is collapsed. Kept out of the
 * `'use server'` module: such a module may only export async functions.
 */
export const SETUP_COLLAPSED_COOKIE = 'tix_setup_collapsed';
