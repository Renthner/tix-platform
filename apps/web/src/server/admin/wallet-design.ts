import 'server-only';
import { getMediaAsset, getWalletPassDesignRow, resolveWalletDesign } from '@tix/core';
import type { MediaPickerAsset } from '@/components/admin/media-picker';
import type { WalletDesignValues } from '@/components/admin/wallet-settings-forms';
import { getCore } from '@/server/core';

async function asset(id: string | null): Promise<MediaPickerAsset | null> {
  if (!id) return null;
  const row = await getMediaAsset(getCore(), id);
  return row ? { id: row.id, fileName: row.fileName, width: row.width, height: row.height } : null;
}

/**
 * Form values of a wallet pass design. For an event without its own design the effective
 * (inherited) values are shown, so saving creates an override from the current look.
 */
export async function loadWalletDesignValues(
  eventId: string | null,
): Promise<{ values: WalletDesignValues; isOverride: boolean }> {
  const core = getCore();
  const own = await getWalletPassDesignRow(core.db, eventId);
  const resolved = own ?? (await resolveWalletDesign(core, eventId));
  const [logo, icon, strip] = await Promise.all([
    asset(resolved.logoAssetId),
    asset(resolved.iconAssetId),
    asset(resolved.stripAssetId),
  ]);
  return {
    isOverride: Boolean(own),
    values: {
      backgroundColor: resolved.backgroundColor,
      foregroundColor: resolved.foregroundColor,
      labelColor: resolved.labelColor,
      logoText: resolved.logoText ?? '',
      description: resolved.description ?? '',
      logo,
      icon,
      strip,
    },
  };
}
