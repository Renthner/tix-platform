import { describe, expect, it } from 'vitest';
import { PUBLIC_MEDIA_KINDS, isMediaKindAllowed, mediaKindsFor } from '../src';

describe('media kind compatibility', () => {
  it('public contexts accept only public kinds', () => {
    expect(mediaKindsFor('public')).toEqual([
      'EVENT_IMAGE',
      'VENUE_BACKGROUND',
      'LOGO',
      'EMAIL_IMAGE',
    ]);
    for (const k of PUBLIC_MEDIA_KINDS) expect(isMediaKindAllowed(k, 'public')).toBe(true);
    expect(isMediaKindAllowed('TICKET_BACKGROUND', 'public')).toBe(false);
    expect(isMediaKindAllowed('WALLET_IMAGE', 'public')).toBe(false);
    expect(isMediaKindAllowed('OTHER', 'public')).toBe(false);
  });

  it('private contexts accept every image kind but never documents', () => {
    expect(isMediaKindAllowed('EVENT_IMAGE', 'private')).toBe(true);
    expect(isMediaKindAllowed('WALLET_IMAGE', 'private')).toBe(true);
    expect(isMediaKindAllowed('TICKET_BACKGROUND', 'private')).toBe(true);
    expect(isMediaKindAllowed('DOCUMENT', 'private')).toBe(false);
    expect(isMediaKindAllowed('DOCUMENT', 'public')).toBe(false);
    expect(mediaKindsFor('private')).not.toContain('DOCUMENT');
  });
});
