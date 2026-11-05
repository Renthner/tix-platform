import type admin from '../../messages/en/admin.json';
import type cart from '../../messages/en/cart.json';
import type common from '../../messages/en/common.json';
import type editor from '../../messages/en/editor.json';
import type queue from '../../messages/en/queue.json';
import type shop from '../../messages/en/shop.json';
import type { routing } from './routing';

declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: {
      common: typeof common;
      shop: typeof shop;
      queue: typeof queue;
      cart: typeof cart;
      admin: typeof admin;
      editor: typeof editor;
    };
  }
}
