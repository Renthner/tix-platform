import type { TicketLayout } from '@tix/shared';
import type { MediaPickerAsset } from '@/components/admin/media-picker';

export interface DesignerEventOption {
  id: string;
  title: string;
}

export interface TicketDesignerProps {
  templateId: string;
  initial: {
    name: string;
    description: string | null;
    pageWidthMm: number;
    pageHeightMm: number;
    background: MediaPickerAsset | null;
    layout: TicketLayout;
  };
  /** Event the template belongs to (library templates: null). */
  eventId: string | null;
  /** Cover image of that event for the canvas. */
  coverAssetId: string | null;
  /** Cover aspect ratio (width / height) for the "match cover" preset. */
  coverAspect: number | null;
  /** Events offered as preview data source (library templates). */
  events: DesignerEventOption[];
  /** Shop default language (language of the base texts) and the languages static texts can be translated into. */
  baseLocale: string;
  translationLocales: string[];
}

export type Draft = TicketDesignerProps['initial'];
