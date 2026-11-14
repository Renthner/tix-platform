import 'server-only';
import {
  detectComposeDrift,
  effectiveUpdateRepository,
  getSetting,
  getUpdateStatus,
  type ComposeDrift,
  type UpdateStatus,
} from '@tix/core';
import { APP_VERSION } from '@tix/shared';
import { getCore } from './core';

export interface UpdateNotice {
  status: UpdateStatus;
  drift: ComposeDrift | null;
}

/**
 * Update notice (newer release for the installation's channel) and docker-compose.yml drift for
 * the super admin dashboard. Never waits for the network (the status comes from the shared Redis
 * cache) and never throws.
 */
export async function loadUpdateNotice(): Promise<UpdateNotice | null> {
  try {
    const core = getCore();
    const defaultRepository = process.env.TIX_UPDATE_REPOSITORY ?? '';
    const [status, general] = await Promise.all([
      getUpdateStatus(core, {
        channel: process.env.TIX_CHANNEL ?? '',
        currentVersion: APP_VERSION,
        defaultRepository,
      }),
      getSetting(core, 'general'),
    ]);
    const drift = detectComposeDrift({
      composeVersion: process.env.TIX_COMPOSE_VERSION,
      appVersion: APP_VERSION,
      repository: effectiveUpdateRepository(general.updateRepository, defaultRepository),
    });
    return { status, drift };
  } catch {
    return null;
  }
}
