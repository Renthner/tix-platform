import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../apps/web/src/lib/api';
import {
  fieldForPath,
  mapIssuesToFields,
  validationIssues,
} from '../../../apps/web/src/lib/validation-issues';
import { boxOfficeSellSchema } from '../src/orders/box-office';

const FIELDS = {
  'buyer.email': 'bo-email',
  'buyer.address': 'bo-street',
  'buyer.address.postalCode': 'bo-postalCode',
  note: 'bo-note',
};

describe('validation feedback helpers', () => {
  it('maps zod issue paths to control ids (longest prefix wins)', () => {
    expect(fieldForPath('buyer.address.postalCode', FIELDS)).toBe('bo-postalCode');
    expect(fieldForPath('buyer.address.city', FIELDS)).toBe('bo-street');
    expect(fieldForPath('lines.0.seatId', FIELDS)).toBeNull();
  });

  it('reads the issues of a VALIDATION_FAILED API error', () => {
    const body = {
      lines: [
        {
          eventId: crypto.randomUUID(),
          seatId: crypto.randomUUID(),
          ticketTypeId: crypto.randomUUID(),
        },
      ],
      payment: 'CASH',
      buyer: {
        email: 'not-an-email',
        address: { street: 'x', postalCode: '', city: 'c', country: 'DE' },
      },
    };
    const parsed = boxOfficeSellSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    const issues = parsed.error!.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    const err = new ApiError('VALIDATION_FAILED', 'Invalid request', 422, { issues });
    expect(mapIssuesToFields(validationIssues(err)!, FIELDS)).toEqual({
      'bo-email': expect.any(String),
      'bo-postalCode': expect.any(String),
    });
    expect(validationIssues(new ApiError('SEAT_UNAVAILABLE', 'x', 409))).toBeNull();
    expect(validationIssues(new Error('boom'))).toBeNull();
  });
});
