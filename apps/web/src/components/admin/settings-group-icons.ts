import {
  CreditCard,
  Mail,
  Palette,
  ServerCog,
  ShoppingCart,
  Store,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import type { SettingsGroupKey } from '@/lib/settings-tabs';

/** Icon of each settings group (menu and overview headings; not used for the single pages). */
export const SETTINGS_GROUP_ICONS: Record<SettingsGroupKey, LucideIcon> = {
  shop: Store,
  design: Palette,
  sales: ShoppingCart,
  payment: CreditCard,
  communication: Mail,
  tickets: Ticket,
  system: ServerCog,
};
