import { escapeHtml, trustedHtml } from '../email/template';
import type { CoreContext } from '../context';
import { mailTranslator } from '../i18n/mail-messages';
import { coreLog } from '../log';
import { loadOrderCalendarEvents, orderCalendarPath } from './data';

const BUTTON =
  'display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px;margin:0 8px 8px 0';

/**
 * `{{calendarLinks}}` / `{{directionsUrl}}` e-mail variables of an order: per event (order
 * items that still hold seats) buttons for the .ics download, Google Calendar and directions.
 * Empty without `appUrl` or events; never throws.
 */
export async function calendarVariables(
  ctx: CoreContext,
  orderId: string,
  locale: string,
): Promise<{
  calendarLinks: ReturnType<typeof trustedHtml>;
  directionsUrl: string | null;
}> {
  const empty = { calendarLinks: trustedHtml('', ''), directionsUrl: null };
  if (!ctx.appUrl) return empty;
  try {
    const eventsOfOrder = await loadOrderCalendarEvents(ctx, orderId, { locale });
    if (eventsOfOrder.length === 0) return empty;
    const t = mailTranslator(locale);
    const base = ctx.appUrl;
    const button = (url: string, label: string) =>
      `<a href="${escapeHtml(url)}" style="${BUTTON}">${escapeHtml(label)}</a>`;
    const blocks = eventsOfOrder.map((event) => {
      const icsUrl = base + orderCalendarPath(ctx, orderId, event.id);
      return {
        directionsUrl: event.directionsUrl,
        html: `<p style="margin:0 0 4px;font-size:13px;color:#52525b">${escapeHtml(event.title)}</p><p style="margin:0 0 14px">${button(icsUrl, t('calendar.ics'))}${button(event.googleUrl, t('calendar.google'))}${button(event.directionsUrl, t('calendar.directions'))}</p>`,
        text: [
          event.title,
          `${t('calendar.ics')}: ${icsUrl}`,
          `${t('calendar.google')}: ${event.googleUrl}`,
          `${t('calendar.directions')}: ${event.directionsUrl}`,
        ].join('\n'),
      };
    });
    return {
      calendarLinks: trustedHtml(
        blocks.map((b) => b.html).join(''),
        blocks.map((b) => b.text).join('\n\n'),
      ),
      directionsUrl: blocks[0]!.directionsUrl,
    };
  } catch (err) {
    coreLog.error({ err }, '[calendar] could not build calendar links');
    return empty;
  }
}
