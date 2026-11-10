import type account from '../../messages/en/account.json';
import type accounting from '../../messages/en/accounting.json';
import type admin from '../../messages/en/admin.json';
import type adminSecurity from '../../messages/en/adminSecurity.json';
import type backups from '../../messages/en/backups.json';
import type banking from '../../messages/en/banking.json';
import type customers from '../../messages/en/customers.json';
import type cart from '../../messages/en/cart.json';
import type checkout from '../../messages/en/checkout.json';
import type common from '../../messages/en/common.json';
import type editor from '../../messages/en/editor.json';
import type emailTemplates from '../../messages/en/emailTemplates.json';
import type fees from '../../messages/en/fees.json';
import type mail from '../../messages/en/mail.json';
import type orders from '../../messages/en/orders.json';
import type queue from '../../messages/en/queue.json';
import type shop from '../../messages/en/shop.json';
import type ticketDesigner from '../../messages/en/ticketDesigner.json';
import type translations from '../../messages/en/translations.json';
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
      adminSecurity: typeof adminSecurity;
      customers: typeof customers;
      editor: typeof editor;
      checkout: typeof checkout;
      account: typeof account;
      accounting: typeof accounting;
      orders: typeof orders;
      backups: typeof backups;
      banking: typeof banking;
      mail: typeof mail;
      fees: typeof fees;
      emailTemplates: typeof emailTemplates;
      ticketDesigner: typeof ticketDesigner;
      translations: typeof translations;
    };
  }
}
