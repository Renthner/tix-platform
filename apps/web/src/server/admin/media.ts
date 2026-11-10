'use server';

import {
  DomainError,
  deleteMediaAssets,
  renameMediaAsset,
  sweepOrphanMediaObjects,
  tryDeleteMediaAsset,
} from '@tix/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, formError, success, text, zodFieldErrors } from './form';

const idSchema = z.uuid();

export async function renameMediaAction(
  assetId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const name = z.string().min(1).max(150).safeParse(text(fd, 'name'));
  if (!name.success) return fieldError({ name: zodFieldErrors(name.error)._ ?? 'required' });
  const core = getCore();
  try {
    await renameMediaAsset(core, assetId, name.data, async (tx, asset) => {
      await audit(tx, session, 'media.rename', 'media_asset', asset.id, { file: asset.fileName });
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === 'MEDIA_NOT_FOUND') return formError('notFound');
    throw err;
  }
  revalidatePath('/', 'layout');
  return success('saved');
}

/** Deletes one unused asset (re-checked and locked inside the core transaction). */
export async function deleteMediaAction(assetId: string, _prev: ActionState): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const core = getCore();
  try {
    const result = await tryDeleteMediaAsset(core, assetId, async (tx, asset) => {
      await audit(tx, session, 'media.delete', 'media_asset', asset.id, {
        kind: asset.kind,
        file: asset.fileName,
        bytes: asset.sizeBytes,
      });
    });
    if (!result.deleted) return formError('mediaInUse');
  } catch (err) {
    if (err instanceof DomainError && err.code === 'MEDIA_NOT_FOUND') return formError('notFound');
    if (err instanceof DomainError && err.code === 'MEDIA_PROTECTED') return formError('generic');
    throw err;
  }
  revalidatePath('/', 'layout');
  return success('deleted');
}

/** Deletes exactly the previewed ids (bound by the page); assets used meanwhile are skipped. */
export async function bulkDeleteMediaAction(
  assetIds: string[],
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const ids = z.array(idSchema).max(500).safeParse(assetIds);
  if (!ids.success || ids.data.length === 0) return formError('generic');
  const result = await deleteMediaAssets(getCore(), ids.data, async (tx, asset) => {
    await audit(tx, session, 'media.delete', 'media_asset', asset.id, {
      kind: asset.kind,
      file: asset.fileName,
      bytes: asset.sizeBytes,
      bulk: true,
    });
  });
  revalidatePath('/', 'layout');
  if (result.deleted.length === 0 && result.blocked.length > 0) return formError('mediaInUse');
  return success('deleted');
}

/** Removes storage objects without a catalogue row (leftovers of failed deletions). */
export async function sweepMediaOrphansAction(_prev: ActionState): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const core = getCore();
  const result = await sweepOrphanMediaObjects(core);
  await audit(core.db, session, 'media.sweep', 'media_asset', null, { ...result });
  return success('deleted');
}
