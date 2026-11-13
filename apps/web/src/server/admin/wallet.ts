'use server';

import {
  checkAppleWalletConfiguration,
  type WalletCheckIssue,
  checkGoogleWalletConfiguration,
  clearSecretSetting,
  deleteWalletPassDesign,
  getMediaAsset,
  getSecretSetting,
  parseAppleCertificates,
  parseServiceAccountJson,
  saveSecretSetting,
  saveSetting,
  saveWalletPassDesign,
} from '@tix/core';
import { isMediaKindAllowed } from '@tix/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, flag, success, text, zodFieldErrors } from './form';

type Errors = Partial<Record<string, FieldErrorCode>>;

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** PEM text as entered / uploaded: normalised line endings, trimmed. */
function pem(fd: FormData, name: string): string | undefined {
  const v = fd.get(name);
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\r\n/g, '\n').trim();
  return t === '' ? undefined : t;
}

// ─── Apple ──────────────────────────────────────────────────────────────────

export async function saveAppleWalletAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const core = getCore();
  const errors: Errors = {};
  const enabled = flag(fd, 'enabled');
  const input = {
    enabled,
    passTypeIdentifier: text(fd, 'passTypeIdentifier'),
    teamIdentifier: text(fd, 'teamIdentifier'),
    organizationName: text(fd, 'organizationName'),
  };

  const stored = await getSecretSetting(core, 'wallet.apple.certificates');
  const clear = flag(fd, 'clearCertificates');
  const passphrase = fd.get('signerKeyPassphrase');
  const changes = {
    signerCertificatePem: pem(fd, 'signerCertificatePem'),
    signerKeyPem: pem(fd, 'signerKeyPem'),
    wwdrCertificatePem: pem(fd, 'wwdrCertificatePem'),
    signerKeyPassphrase:
      typeof passphrase === 'string' && passphrase !== '' ? passphrase : undefined,
  };
  const touched = Object.values(changes).some((v) => v !== undefined);
  const base = clear ? null : stored;
  const merged = touched
    ? {
        signerCertificatePem: changes.signerCertificatePem ?? base?.signerCertificatePem,
        signerKeyPem: changes.signerKeyPem ?? base?.signerKeyPem,
        wwdrCertificatePem: changes.wwdrCertificatePem ?? base?.wwdrCertificatePem,
        signerKeyPassphrase: changes.signerKeyPassphrase ?? base?.signerKeyPassphrase,
      }
    : null;
  const willHave = merged
    ? Boolean(merged.signerCertificatePem && merged.signerKeyPem && merged.wwdrCertificatePem)
    : Boolean(stored) && !clear;

  if (enabled) {
    if (!input.passTypeIdentifier) errors.passTypeIdentifier = 'required';
    if (!input.teamIdentifier) errors.teamIdentifier = 'required';
    if (!willHave) errors.signerCertificatePem = 'secretRequired';
  }
  if (merged && willHave) {
    try {
      parseAppleCertificates({
        signerCertificatePem: merged.signerCertificatePem!,
        signerKeyPem: merged.signerKeyPem!,
        wwdrCertificatePem: merged.wwdrCertificatePem!,
        ...(merged.signerKeyPassphrase ? { signerKeyPassphrase: merged.signerKeyPassphrase } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (/WWDR/.test(message)) errors.wwdrCertificatePem = 'invalid';
      else if (/key|passphrase/i.test(message)) errors.signerKeyPem = 'invalid';
      else errors.signerCertificatePem = 'invalid';
    }
  } else if (merged && !clear) {
    // Partial first-time upload: the three PEMs belong together.
    if (!merged.signerCertificatePem) errors.signerCertificatePem = 'required';
    if (!merged.signerKeyPem) errors.signerKeyPem = 'required';
    if (!merged.wwdrCertificatePem) errors.wwdrCertificatePem = 'required';
  }
  if (Object.keys(errors).length > 0) return fieldError(errors);

  let saved;
  try {
    saved = await saveSetting(core, 'wallet.apple', input, session.userId);
  } catch (err) {
    if (err instanceof z.ZodError) return fieldError(zodFieldErrors(err));
    throw err;
  }
  let secretChange: 'replaced' | 'removed' | null = null;
  if (merged && willHave) {
    await saveSecretSetting(
      core,
      'wallet.apple.certificates',
      {
        signerCertificatePem: merged.signerCertificatePem,
        signerKeyPem: merged.signerKeyPem,
        wwdrCertificatePem: merged.wwdrCertificatePem,
        ...(merged.signerKeyPassphrase ? { signerKeyPassphrase: merged.signerKeyPassphrase } : {}),
      },
      session.userId,
    );
    secretChange = 'replaced';
  } else if (clear) {
    await clearSecretSetting(core, 'wallet.apple.certificates');
    secretChange = 'removed';
  }
  await audit(core.db, session, 'settings.update', 'system_setting', 'wallet.apple', {
    value: saved,
    ...(secretChange ? { secret: { key: 'wallet.apple.certificates', change: secretChange } } : {}),
  });
  revalidatePath('/', 'layout');
  return success('saved');
}

// ─── Google ─────────────────────────────────────────────────────────────────

export async function saveGoogleWalletAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const core = getCore();
  const errors: Errors = {};
  const enabled = flag(fd, 'enabled');
  const input = {
    enabled,
    issuerId: text(fd, 'issuerId'),
    classPrefix: text(fd, 'classPrefix'),
  };
  const json = pem(fd, 'serviceAccountJson');
  const clear = flag(fd, 'clearCredentials');
  const stored = await getSecretSetting(core, 'wallet.google.credentials');
  const willHave = json !== undefined || (Boolean(stored) && !clear);
  if (json) {
    try {
      parseServiceAccountJson(json);
    } catch {
      errors.serviceAccountJson = 'invalid';
    }
  }
  if (enabled) {
    if (!input.issuerId) errors.issuerId = 'required';
    if (!willHave) errors.serviceAccountJson = 'secretRequired';
  }
  if (Object.keys(errors).length > 0) return fieldError(errors);

  let saved;
  try {
    saved = await saveSetting(core, 'wallet.google', input, session.userId);
  } catch (err) {
    if (err instanceof z.ZodError) return fieldError(zodFieldErrors(err));
    throw err;
  }
  let secretChange: 'replaced' | 'removed' | null = null;
  if (json) {
    await saveSecretSetting(
      core,
      'wallet.google.credentials',
      { serviceAccountJson: json },
      session.userId,
    );
    secretChange = 'replaced';
  } else if (clear) {
    await clearSecretSetting(core, 'wallet.google.credentials');
    secretChange = 'removed';
  }
  await audit(core.db, session, 'settings.update', 'system_setting', 'wallet.google', {
    value: saved,
    ...(secretChange ? { secret: { key: 'wallet.google.credentials', change: secretChange } } : {}),
  });
  revalidatePath('/', 'layout');
  return success('saved');
}

// ─── Configuration checks ───────────────────────────────────────────────────

export type WalletCheckLabel = 'subject' | 'signerExpires' | 'wwdrExpires' | 'serviceAccount';

export type WalletCheckState =
  | { status: 'idle' }
  | {
      status: 'done';
      ok: boolean;
      errors: WalletCheckIssue[];
      warnings: WalletCheckIssue[];
      details: { label: WalletCheckLabel; value: string }[];
      at: number;
    };

export async function checkAppleWalletAction(_prev: WalletCheckState): Promise<WalletCheckState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const core = getCore();
  const result = await checkAppleWalletConfiguration(core);
  await audit(core.db, session, 'settings.wallet.check', 'system_setting', 'wallet.apple', {
    ok: result.ok,
  });
  return {
    status: 'done',
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    details: [
      ...(result.signerSubject ? [{ label: 'subject' as const, value: result.signerSubject }] : []),
      ...(result.signerExpiresAt
        ? [{ label: 'signerExpires' as const, value: result.signerExpiresAt }]
        : []),
      ...(result.wwdrExpiresAt
        ? [{ label: 'wwdrExpires' as const, value: result.wwdrExpiresAt }]
        : []),
    ],
    at: Date.now(),
  };
}

export async function checkGoogleWalletAction(_prev: WalletCheckState): Promise<WalletCheckState> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const core = getCore();
  const result = await checkGoogleWalletConfiguration(core);
  await audit(core.db, session, 'settings.wallet.check', 'system_setting', 'wallet.google', {
    ok: result.ok,
  });
  return {
    status: 'done',
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    details: result.serviceAccount
      ? [{ label: 'serviceAccount' as const, value: result.serviceAccount }]
      : [],
    at: Date.now(),
  };
}

// ─── Pass design ────────────────────────────────────────────────────────────

const uuidOrNull = (fd: FormData, name: string): string | null => {
  const v = text(fd, name);
  return v && z.uuid().safeParse(v).success ? v : null;
};

/** Saves the global (`eventId` null) or the per-event pass design. */
export async function saveWalletDesignAction(
  eventId: string | null,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const core = getCore();
  const errors: Errors = {};
  const colors = {
    backgroundColor: text(fd, 'backgroundColor') ?? '',
    foregroundColor: text(fd, 'foregroundColor') ?? '',
    labelColor: text(fd, 'labelColor') ?? '',
  };
  for (const [name, value] of Object.entries(colors))
    if (!HEX.test(value)) errors[name] = 'invalid';
  const logoText = text(fd, 'logoText') ?? null;
  const description = text(fd, 'description') ?? null;
  if (logoText && logoText.length > 40) errors.logoText = 'tooLong';
  if (description && description.length > 200) errors.description = 'tooLong';
  // Pass images are private (any library image is fine); unknown ids / documents are rejected.
  const assetIds: Record<'logoAssetId' | 'iconAssetId' | 'stripAssetId', string | null> = {
    logoAssetId: uuidOrNull(fd, 'logoAssetId'),
    iconAssetId: uuidOrNull(fd, 'iconAssetId'),
    stripAssetId: uuidOrNull(fd, 'stripAssetId'),
  };
  for (const [name, id] of Object.entries(assetIds)) {
    if (!id) continue;
    const asset = await getMediaAsset(core, id);
    if (!asset || !isMediaKindAllowed(asset.kind, 'private')) errors[name] = 'invalid';
    // Apple Wallet only accepts PNG; with library reuse a JPEG/WebP event image is easy to pick.
    else if (asset.mimeType !== 'image/png') errors[name] = 'pngOnly';
  }
  if (Object.keys(errors).length > 0) return fieldError(errors);

  const input = {
    ...colors,
    logoText,
    description,
    ...assetIds,
    heroAssetId: null,
  };
  await saveWalletPassDesign(core.db, eventId, input);
  await audit(core.db, session, 'wallet.design.update', 'wallet_pass_design', eventId, input);
  revalidatePath('/', 'layout');
  return success('saved');
}

/** Removes the per-event override (the event then uses the global design). */
export async function resetWalletDesignAction(
  eventId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const core = getCore();
  await deleteWalletPassDesign(core.db, eventId);
  await audit(core.db, session, 'wallet.design.reset', 'wallet_pass_design', eventId);
  revalidatePath('/', 'layout');
  return success('reset');
}
