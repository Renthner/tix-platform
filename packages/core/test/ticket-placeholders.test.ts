import { TICKET_FIELD_VARIABLES, TICKET_LABEL_KEYS, type TicketTextElement } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import { elementText, ticketVariables, type TicketRenderData } from '../src';

const data: TicketRenderData = {
  locale: 'en',
  timeZone: 'Europe/Berlin',
  eventTitle: 'Sample event',
  eventSubtitle: 'Subtitle',
  startsAt: new Date(Date.UTC(2030, 5, 14, 17, 30)),
  doorsOpenAt: new Date(Date.UTC(2030, 5, 14, 16, 30)),
  venueName: 'City hall',
  venueAddress: 'Main Street 1',
  kind: 'SEAT',
  sectionLabel: 'A',
  rowLabel: '7',
  seatLabel: '12',
  entranceLabel: 'North',
  priceCategory: 'Category 1',
  ticketType: 'Standard',
  priceGross: 3500,
  currency: 'EUR',
  buyerName: 'Jane Buyer',
  attendeeName: 'Jane Attendee',
  orderNumber: 'TIX-1',
  ticketCode: 'ABCDE-FGHJK',
  organizerName: 'Organizer',
  qrPayload: 'tix://v1/x',
};

const staticText = (text: string) => ({ field: 'STATIC_TEXT', text }) as TicketTextElement;

describe('ticket placeholders', () => {
  const names = [
    ...Object.values(TICKET_FIELD_VARIABLES),
    ...TICKET_LABEL_KEYS.map((k) => `label.${k}`),
  ];

  it('every designer placeholder resolves to a non-empty value in the renderer', () => {
    for (const name of names) {
      expect(elementText(staticText(`{{${name}}}`), data), name).not.toBe('');
    }
  });

  it('the renderer supports exactly the designer placeholders', () => {
    expect(Object.keys(ticketVariables(data)).sort()).toEqual([...names].sort());
  });
});
