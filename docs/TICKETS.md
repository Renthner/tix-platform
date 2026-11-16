# Tickets and signed QR codes

Tickets are issued when an order becomes PAID (including free 0 EUR orders): one VALID ticket per
CONFIRMED order item. Every ticket carries a QR payload signed with an **event-specific Ed25519
key**, so a scanner can verify authenticity offline using only the event's public key.

Code: `packages/shared/src/tickets/qr.ts` (format, isomorphic), `packages/shared/src/server/ed25519.ts`
(Node signing helpers), `packages/core/src/tickets/{keys,issue}.ts` (keys, issuance, backfill).

## QR payload format "tix v1"

```
tix://v1/{keyId}.{eventId}.{ticketId}.{seatInfo}.{signature}
```

Segments are separated by a literal `.`; no segment contains a `.` (all are base64url or the key id).

| Segment     | Encoding                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `keyId`     | `[A-Za-z0-9_-]{1,16}` (server generates 8 chars). Selects the public key (rotation/revocation)  |
| `eventId`   | UUID -> its 16 raw bytes -> base64url without padding (22 chars)                                |
| `ticketId`  | same as `eventId`                                                                               |
| `seatInfo`  | UTF-8 string (max 80 bytes, may be empty) -> base64url without padding                          |
| `signature` | 64-byte Ed25519 signature (RFC 8032, pure Ed25519, no prehash/context) -> base64url, no padding |

base64url = RFC 4648 section 5 alphabet (`A-Z a-z 0-9 - _`), **no `=` padding**. Decoders must reject
padding, other characters, and non-canonical trailing bits (the re-encoded value must equal the
input).

**Signed bytes:** the UTF-8 bytes of the payload string up to, but excluding, the **last** `.` –
i.e. `tix://v1/{keyId}.{eventId}.{ticketId}.{seatInfo}` including the `tix://v1/` prefix. The
signature segment is everything after the last `.`.

**seatInfo content** (informational, authenticated by the signature; the block label is omitted
when the section's `show_label_on_ticket` is off):

- seats: `{block}|{row}|{seat}` (hidden/empty parts keep their `|`, e.g. `|R5|12`)
- standing areas: `GA:{block}`
- `|` inside labels is replaced by `/`; the string is truncated at 80 UTF-8 bytes on a code point
  boundary.

**Verification (scanner):**

1. check prefix and exactly 5 `.`-separated segments;
2. decode `eventId`/`ticketId` to 16 bytes each and the signature to 64 bytes (strict base64url);
3. **WRONG_EVENT:** the payload's `eventId` must equal the event the scanner is checking in
   (`verifyTicketPayload(payload, expectedEventId, resolver)`); reject otherwise, before any key
   lookup;
4. look up the 32-byte public key by **`(eventId, keyId)`** (resolvers must use both; key ids are
   only unique per event) - unknown or REVOKED key means invalid, RETIRED keys are still valid;
5. verify the Ed25519 signature over the signed bytes. Verifiers must **reject signatures whose
   scalar half `S` is >= the group order L** (RFC 8032 section 5.1.7; the last 32 bytes of the
   signature, little endian) so a signature cannot be malleated into a second valid spelling. The
   WebCrypto/Node verifier does this; the Kotlin scanner must check it explicitly if its library
   does not.

A valid signature only proves authenticity; cancellation (`status != VALID`) and duplicate scans are
decided from the synced ticket list. **Detect duplicate scans by `ticketId`, never by the payload
string** (a re-issued ticket has a new id; the same ticket can never be presented as a different
payload, but string comparison is fragile). Tickets bought after the last sync verify by signature
alone.

Size: a typical payload is about 160-175 characters (the vector below is 163).

### Test vector

Seed (private key, 32 bytes): `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`

Public key (base64url): `A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg`

| Field    | Value                                  |
| -------- | -------------------------------------- |
| keyId    | `k1`                                   |
| eventId  | `00000000-0000-4000-8000-000000000001` |
| ticketId | `00000000-0000-4000-8000-000000000002` |
| seatInfo | `Parkett\|R5\|12`                      |

Signed bytes:

```
tix://v1/k1.AAAAAAAAQACAAAAAAAAAAQ.AAAAAAAAQACAAAAAAAAAAg.UGFya2V0dHxSNXwxMg
```

Payload (163 characters):

```
tix://v1/k1.AAAAAAAAQACAAAAAAAAAAQ.AAAAAAAAQACAAAAAAAAAAg.UGFya2V0dHxSNXwxMg.rtTDrMv6GaEmTIQMvUPkOC7LGLnEOSzp816oE6eIZdLaTuccet2SFH1H-UxDjs-uXuucamvw30cb6SeM4bMkBA
```

Ed25519 is deterministic, so a conforming implementation must reproduce the signature exactly.
The vector is asserted in `packages/shared/test/tickets.test.ts`.

## Signing keys

Table `event_signing_keys` (one row per key, exactly one ACTIVE per event):

- The private key is the 32-byte seed, stored as secret-box JSON `{"seed": "<base64url>"}` with AAD
  `signing-key:<event_signing_keys.id>` (row UUID), so a ciphertext cannot be moved to another row.
- `ensureEventSigningKey` creates the ACTIVE key lazily; creation and rotation are serialised per
  event with an advisory lock (the partial unique index is the backstop).
- **Concurrency:** the ACTIVE key is read `FOR SHARE` during issuance, while revoke (`FOR UPDATE`)
  and rotate (`UPDATE`) take row locks. Issuance therefore waits for a running revoke/rotate and
  revoke/rotate wait for in-flight issuance (so `affectedTickets` includes tickets issued
  concurrently). After the wait the ACTIVE check is re-evaluated; if the key is gone, issuance falls
  through to the advisory-locked path and uses the new ACTIVE key. A key-id collision (48-bit
  random id) is retried; a stored public key that does not match its decrypted seed aborts signing.
- `rotateEventSigningKey`: old key -> RETIRED (existing tickets keep verifying), new ACTIVE key.
- `revokeEventSigningKey`: -> REVOKED (a new ACTIVE key is created when it was active); tickets
  signed with it must be re-issued (`reissueTicketsOfRevokedKeys`).
- `eventPublicKeys(ctx, eventId, { excludeRevoked? })` returns `{ keyId, publicKey, status }[]`.
  Scanner sync should pass `excludeRevoked: true` so revoked keys are never shipped; the default
  includes them flagged `REVOKED` (admin views) and they must not be trusted.

## Issuance

- `ensureOrderTickets(ctx, orderId)`: idempotent, serialised per order (advisory lock
  `order-tickets:<id>`), all-or-nothing in one transaction. Ticket code: 10 characters of Crockford
  base32 (no I, L, O, U), displayed `XXXXX-XXXXX` (`formatTicketCode`, `normalizeTicketCode`).
  Attendee name: the item's name, else the buyer. Only **PAID** orders get tickets (other statuses
  return no tickets); the order row is read `FOR SHARE`. Phase-5 refund and seat-change flows must
  lock the order row `FOR UPDATE` to serialise with issuance. Per-event keys are acquired in sorted
  event-id order (deadlock avoidance).
- `processPaidOrder` (documents queue job `order-paid`) issues tickets after the invoice and
  **before** the confirmation e-mail; a failure retries the whole (idempotent) job.
- `reissueTicket`: old ticket -> REPLACED (`replaced_by_ticket_id`), new id/code/signature from the
  current order item snapshot. The check-in state (`check_in_state`, first check-in time/device,
  count, last scan) is **copied to the new ticket**, so a checked-in guest's new QR stays checked in;
  the old row keeps its history.
- Cancelling an order voids its VALID tickets (`voidTicketsForItems`, status CANCELLED/REFUNDED);
  Refunds of paid orders call the same helper.
- `reissueTicketsOfRevokedKeys` skips tickets that changed concurrently (`TICKET_NOT_VALID` /
  `TICKET_CONFLICT`), counts only successes, returns `{ reissued, orderIds }` and queues one
  `TICKETS_RESENT` e-mail per affected order (outbox row, dispatched after commit).
- **Backfill:** the documents queue runs the scheduled job `ensure-missing-tickets` (every 10
  minutes and shortly after worker start) calling `backfillMissingTickets`:
  - PAID orders with missing tickets that were **paid within the last 48 hours** and have no
    `PAYMENT_RECEIVED_TICKETS` row in `email_messages` are handed back to the `order-paid` job
    (re-enqueued with jobId `order-paid-<id>`; BullMQ dedupes while that job id still exists), so
    tickets, invoice and e-mail go out through the normal path;
  - older orders (and runs without a job queue) get tickets issued **silently, without e-mail**, so
    historic orders are never mailed unexpectedly;
  - VALID tickets whose signing key is REVOKED are re-issued (with the `TICKETS_RESENT` mails above).

## Self-service (name change, transfer)

Code: `packages/core/src/tickets/self-service.ts`; settings `ticketSelfService` (global, Settings →
Customer accounts) with a per-event override (event tab "Sales": inherit / own values / off).
Switched **off by default**. Customers act on the order page (order access token or signed-in
owner); admins can do both without any policy from the admin order page. Every change is stored
in `ticket_changes`, written to the order history and (admin) the audit log, and rate limited.

- **Policy:** enabled, allow name change, allow transfer, deadline (hours before the event start,
  0 = until the start), optional maximum customer changes per seat (counted over the whole
  re-issue chain of an order item; an event can inherit the global value, set its own or "0 =
  unlimited" to switch a global limit off for that event). Blocked for unpaid / cancelled / refunded tickets and for
  tickets that were already checked in. Test orders and box-office orders follow the same
  policy (box-office complimentary tickets are not excluded; switch the feature off per event if
  they should be).
- **Name change:** only `tickets.attendee_name` changes. The name is **not** part of the signed QR
  payload (`tix://v1/{keyId}.{eventId}.{ticketId}.{seatInfo}.{sig}`), so ticket id and QR stay.
  The tickets trigger bumps `sync_version` / `sync_xid`: scanners show the new name after their
  next sync. Stored order PDFs and the cached Apple pass are discarded and rendered again on
  demand; an existing Google Wallet object is updated in place. Apple passes cannot be pushed
  without APNs: an already added Apple pass keeps the old name until it is added again.
- **Transfer:** the old ticket becomes `REPLACED` (scanner decision `REJECTED_TICKET_VOID`, RED), a
  new ticket (new id, code, signature) for the same order item is created with the recipient as
  attendee and `holder_email` set. Order, invoice and payments stay with the buyer. The buyer's
  order PDF / wallet buttons / e-mails no longer contain the ticket.
- **Who may change a handed-over ticket (client decision):** once a ticket has been transferred
  the original **buyer can no longer change it** (no rename, no re-transfer; the order page only
  shows "passed on to ..."). Only the current **holder** may pass it on, on their ticket page
  (`/tickets/{id}?t=...`, `POST /api/tickets/{id}/transfer`) under the same deadline, limits and
  policy; the holder cannot rename it (the name is the one the transferer gave). **Admins can always
  intervene**, including **handing the ticket back to the buyer**: an admin "transfer" to the buyer's
  own address (order e-mail or the owning customer account's e-mail) un-hands the ticket - no
  `holder_email`, attendee = buyer name, the previous holder is told the ticket is gone and the buyer
  receives the tickets again (`TICKETS_RESENT`). For customers the buyer's addresses are refused
  (`SELF_TRANSFER`).
- **Hard caps against use as an e-mail relay** (customers only, independent of the settings,
  "unlimited" included): at most 10 transfers per seat ever, 20 per order and 5 per recipient address
  within 24 hours (the latter across all orders). Exceeding them returns `TRANSFER_LIMIT_REACHED`
  (429) / blocks the button with "limit reached". Admins are not capped. The recipient mail has a
  neutral subject (no buyer name), the sender's message is HTML-escaped and shown with its line
  breaks, and names in the body are shortened.
- **Holder notifications:** the holder of a handed-over ticket gets `TICKET_HOLDER_UPDATED` when the
  ticket is re-issued for them (seat or tariff change, signing key rotation, order paid again after a
  bank allocation reversal; a seat change honours "notify customer") and `TICKET_HOLDER_CANCELLED`
  when it becomes invalid (cancellation, refund, reversal, admin re-assignment). Both contain the
  ticket only, never order data. **Refunds always go to the buyer** - the holder is not refunded and
  is told so. After a bank allocation reversal and a new payment the re-issued ticket keeps the holder
  and the attendee name (the latest earlier ticket of the seat carries them).
- **Google Wallet:** the object of a replaced / cancelled / refunded ticket is switched to
  `INACTIVE` (best effort, retried by the ticket backfill job; errors are logged and never block the
  change).
- **Recipient access:** the e-mail `TICKET_TRANSFER_RECEIVED` (no order data) links to
  `/{locale}/tickets/{ticketId}?t=<holder token>`; `/api/tickets/{id}/{pdf|pkpass|google}` accept only
  that HMAC token (type `ticket`, bound to the ticket chain; order tokens do not verify). The link
  follows re-issues for the same holder (seat change, key rotation) and shows "passed on" /
  "no longer valid" once the ticket was transferred again, cancelled or refunded.
  `TICKET_TRANSFER_SENT` confirms to the buyer.
- **Privacy:** recipient name / e-mail / message live in `tickets` and `ticket_changes`; both are
  part of the GDPR export and are erased with the customer's order data. The mails to holders have no
  order link, so they carry the order id in the mail envelope (`sourceOrderId`) and are erased with
  the buyer. The holder address of a ticket that is still **valid** is kept (a third party keeps
  their ticket); on invalid tickets it is erased.

## Ticket PDFs and the designer

Code: `packages/core/src/tickets/{pdf,render,template-admin}.ts`, layout schema
`packages/shared/src/schemas/ticket-template.ts`, built-in design
`packages/shared/src/tickets/default-layout.ts`, admin UI `apps/web/src/components/admin/ticket-designer/`.

**Template resolution** (per ticket): price category override (`price_categories.ticket_template_id`)
-> event template (`events.ticket_template_id`) -> global default (`ticket_templates.is_default`,
seeded as "Standard ticket", insert-only) -> built-in design (no DB row). A template whose stored
layout no longer validates is skipped. Event templates (`event_id` set) can only be assigned inside
their own event; deleting a template makes events/categories fall back to the next level; the
default cannot be deleted.

**Size:** templates store any page size from 20 to 2000 mm - tickets are not tied to a DIN format. The
built-in design is 150 mm wide with a full-width 16:9 header band for the event cover (so a
recommended cover is not cropped) and the data block + QR code below (about 150 x 150 mm; the
height follows from the cover aspect, see `defaultTicketDesign`). The designer offers presets and
"match the event cover", which resizes the band and moves everything below it.

**Layout elements:** text fields (`TICKET_FIELD_KEYS`, `STATIC_TEXT` with `{{placeholders}}` and the
localized `{{label.date}}` ... labels), images, shapes, `cover` (event cover, `hero_image_asset_id`),
the QR box and an optional page background. Fonts are the PDF standard fonts (Helvetica, Times,
Courier); texts outside WinAnsi are transliterated (no embedded Unicode font yet). Long text wraps
and shrinks (down to 40 % of the size) to fit its box. Dates use the event time zone and the order
locale. `show_label_on_ticket` off: the block label is empty in every field/placeholder (the QR
seat info already omits it).

**Storage:** one PDF per order, one page per VALID ticket, at `tickets/<yyyy>/<orderNumber>.pdf` in
the `documents` bucket. It is overwritten on every render, so the stored object always matches the
current tickets; `tickets.pdf_object_key` of the contained tickets points at it. Customer and admin
downloads render fresh (no write); single tickets are rendered on demand and not stored.

**Delivery:** the e-mail attachment type `{ type: 'tickets', orderId }` is resolved when the mail is
sent. `PAYMENT_RECEIVED_TICKETS` carries invoice + ticket PDF, `TICKETS_RESENT` the ticket PDF
(admin "Send tickets again" on the order). A rendering failure retries with the e-mail job's
back-off (about 1 h, then FAILED - the admin can resend); a mail whose tickets were voided since is
sent without the PDF. Routes: `/api/orders/[id]/tickets[/<ticketId>]` (guest token or customer
account, like invoices) and `/api/admin/orders/[id]/tickets[/<ticketId>]`.

**Preview:** `POST /api/admin/ticket-templates/preview` renders an unsaved draft with sample data or
the data of a chosen event; the QR code is a placeholder and never a valid signature.

## Design export / import

A ticket design can be moved between systems as one file (`*.tixticket.json`, format
`tix-ticket-design`, version 1): admin "Ticket designs" (list row action / editor header: Export;
"Import design" card on the list and on the event's Ticket tab). The file holds page size, layout
(fields, QR, shapes, image elements) and the embedded images (background, image elements; base64,
PNG / JPEG / WebP) - no database ids, events, categories or orders. Image elements refer to the
embedded images by local key (`imageKey`). Routes: `GET /api/admin/ticket-templates/[id]/export`,
`POST /api/admin/ticket-templates/import` (multipart `file`, `mode` preview|import, optional
`eventId`, `name`, `assignTo` = `event` | `none` | price category id).

Import always creates a NEW template (library, or owned by the event) and never changes an
existing one. The file is fully re-validated (Zod, 40 MB cap, max. 200 elements, 30 images); images
go through the normal upload pipeline (type detection, size and dimension limits, normalisation)
and are stored as private `TICKET_BACKGROUND` assets; assets created by a failed import are
removed again. The event cover is not exported (it comes from the event the design is used for).
