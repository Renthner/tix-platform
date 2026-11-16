# Event export / import and seat plan replacement

## Event file (`*.tixevent.json`)

**Admin → Events** has an _Export_ button per event (also on the event page) and an _Import event_
button. The file is one JSON document (`format: "tix-event"`, `version: 1`, max. 40 MB).

Included: event settings and texts (incl. translations), dates and sales window, overrides of global
settings, SEO flag, event page layout and info boxes (with their icons), the seat plan (the
seat-plan file format, embedded), price categories, tariffs, the pricing matrix, event fees, the
waiting-room configuration, event-scoped ticket designs, event-scoped e-mail overrides and the
images they use (cover, ticket artwork, plan images – embedded as base64).

Never included: orders, tickets, customers, access and discount codes, waiting list, check-in data,
signing keys, test orders, the Apple / Google wallet design.

Import always creates a **new DRAFT event**:

- fresh ids everywhere and a **fresh ticket signing key**; slug derived from the title (numeric suffix
  on collision) or given explicitly (refused when taken);
- the admin picks the **venue** (venues are not part of the file) and may change title and start.
  Without a changed start all dates are exactly the ones in the file; with a new start the other dates
  move by the same wall-clock difference in the event's time zone (local times of day are kept);
- tax rates are matched by **name and rate** (active rates only), global fees by name – a tax rate
  without an exact active match falls back to the default rate, an adjustment of a global fee that does
  not exist is skipped; both are reported as warnings;
- **e-mail overrides are exported and imported only by SUPER_ADMIN** (the only role that edits e-mail
  templates). For other roles they are left out of the export; on import they are skipped with an
  `EMAIL_TEMPLATE_SKIPPED` warning. For SUPER_ADMIN every row goes through the editor's preparation
  and validation (known key and language, sanitised HTML, subject without line breaks, non-empty
  subject and body, balanced template sections); invalid rows are skipped with a warning;
- nothing in the file is trusted: strict Zod validation (versioned format, size limits, consistency
  checks that mirror the database constraints), all HTML (description, info boxes, translations, e-mail
  bodies) is sanitised, images go through the normal upload pipeline with the media kind chosen by
  usage, symbols are re-sanitised; a failed import stores nothing and removes the images it uploaded.

## Replacing the seat plan of a draft event

**Event → Seating → Use a different seating plan.** Allowed only for a **DRAFT** event with **no order
items (any status, test orders included), no tickets and no live cart holds**. Source: a copy of another
master plan **of the event's venue**, or a seat plan file (`*.tixplan.json`, imported straight into the
event – no master plan is created).

The current plan copy (with all edits and blocked seats) is deleted. Price categories, tariffs and
prices of the event stay; plan categories are matched to price categories **by name**, unknown names
become new categories **without a price and deactivated** (a price of 0 would otherwise be sold as such –
the admin prices and activates them under Pricing; the same applies to plan categories of an imported event
that are not part of its price categories), seats without a matching category stay unassigned. Scanner
entrance assignments of the event (devices, pairing codes) pointed at entrances of the old plan and are
cleared; the result reports how many. The audit entry is written in the swap's transaction; the follow-up
steps (cache, inventory rebuild, live update) are best effort and logged. The swap is
one transaction with the event row locked; the new plan starts at _old version + 1_ so the Redis
inventory mirror and cached public maps of the old plan cannot be reused. Audit actions:
`event.export`, `event.import`, `event.seatplan.replace`.
