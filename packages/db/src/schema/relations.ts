import { relations } from 'drizzle-orm';
import { adminSessions, adminUsers } from './auth';
import {
  bankAccounts,
  bankConnections,
  bankStatementImports,
  bankSyncRuns,
  bankTanChallenges,
  bankTransactionAllocations,
  bankTransactions,
} from './banking';
import { checkInLogs, scannerDeviceEvents, scannerDevices } from './checkin';
import {
  accessCodeRedemptions,
  accessCodes,
  eventSeries,
  eventSigningKeys,
  events,
  fees,
  priceCategories,
  priceCategoryTicketTypes,
  queueAnnouncements,
  queueConfigs,
  ticketTypes,
} from './events';
import {
  customerSessions,
  customerTokens,
  customers,
  invoiceLines,
  invoices,
  orderHistory,
  orderFees,
  orderItems,
  orders,
  payments,
  refundItems,
  refunds,
  tickets,
} from './orders';
import { mediaAssets, taxRates } from './settings';
import { emailMessages, emailTemplates, ticketTemplates, walletPassDesigns } from './templates';
import {
  seatMapElements,
  seatMapEntrances,
  seatMapRows,
  seatMapSections,
  seatMaps,
  seats,
  venues,
} from './venues';

// ─── Auth ───────────────────────────────────────────────────────────────────
export const adminUsersRelations = relations(adminUsers, ({ many }) => ({
  sessions: many(adminSessions),
}));
export const adminSessionsRelations = relations(adminSessions, ({ one }) => ({
  user: one(adminUsers, { fields: [adminSessions.userId], references: [adminUsers.id] }),
}));

// ─── Venues & seat maps ─────────────────────────────────────────────────────
export const venuesRelations = relations(venues, ({ one, many }) => ({
  image: one(mediaAssets, { fields: [venues.imageAssetId], references: [mediaAssets.id] }),
  seatMaps: many(seatMaps),
  events: many(events),
}));

export const seatMapsRelations = relations(seatMaps, ({ one, many }) => ({
  venue: one(venues, { fields: [seatMaps.venueId], references: [venues.id] }),
  clonedFrom: one(seatMaps, {
    fields: [seatMaps.clonedFromId],
    references: [seatMaps.id],
    relationName: 'seat_map_clone',
  }),
  background: one(mediaAssets, {
    fields: [seatMaps.backgroundAssetId],
    references: [mediaAssets.id],
  }),
  event: one(events),
  entrances: many(seatMapEntrances),
  sections: many(seatMapSections),
  rows: many(seatMapRows),
  elements: many(seatMapElements),
  seats: many(seats),
}));

export const seatMapEntrancesRelations = relations(seatMapEntrances, ({ one, many }) => ({
  seatMap: one(seatMaps, { fields: [seatMapEntrances.seatMapId], references: [seatMaps.id] }),
  sections: many(seatMapSections),
}));

export const seatMapSectionsRelations = relations(seatMapSections, ({ one, many }) => ({
  seatMap: one(seatMaps, { fields: [seatMapSections.seatMapId], references: [seatMaps.id] }),
  entrance: one(seatMapEntrances, {
    fields: [seatMapSections.entranceId],
    references: [seatMapEntrances.id],
  }),
  priceCategory: one(priceCategories, {
    fields: [seatMapSections.priceCategoryId],
    references: [priceCategories.id],
  }),
  rows: many(seatMapRows),
  seats: many(seats),
  elements: many(seatMapElements),
}));

export const seatMapRowsRelations = relations(seatMapRows, ({ one, many }) => ({
  seatMap: one(seatMaps, { fields: [seatMapRows.seatMapId], references: [seatMaps.id] }),
  section: one(seatMapSections, {
    fields: [seatMapRows.sectionId],
    references: [seatMapSections.id],
  }),
  seats: many(seats),
}));

export const seatMapElementsRelations = relations(seatMapElements, ({ one, many }) => ({
  seatMap: one(seatMaps, { fields: [seatMapElements.seatMapId], references: [seatMaps.id] }),
  section: one(seatMapSections, {
    fields: [seatMapElements.sectionId],
    references: [seatMapSections.id],
  }),
  asset: one(mediaAssets, { fields: [seatMapElements.assetId], references: [mediaAssets.id] }),
  tableSeats: many(seats),
}));

export const seatsRelations = relations(seats, ({ one, many }) => ({
  seatMap: one(seatMaps, { fields: [seats.seatMapId], references: [seatMaps.id] }),
  section: one(seatMapSections, { fields: [seats.sectionId], references: [seatMapSections.id] }),
  row: one(seatMapRows, { fields: [seats.rowId], references: [seatMapRows.id] }),
  table: one(seatMapElements, {
    fields: [seats.tableElementId],
    references: [seatMapElements.id],
  }),
  priceCategory: one(priceCategories, {
    fields: [seats.priceCategoryId],
    references: [priceCategories.id],
  }),
  orderItems: many(orderItems),
}));

// ─── Events & pricing ───────────────────────────────────────────────────────
export const eventSeriesRelations = relations(eventSeries, ({ many }) => ({
  events: many(events),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  series: one(eventSeries, { fields: [events.seriesId], references: [eventSeries.id] }),
  venue: one(venues, { fields: [events.venueId], references: [venues.id] }),
  seatMap: one(seatMaps, { fields: [events.seatMapId], references: [seatMaps.id] }),
  taxRate: one(taxRates, { fields: [events.taxRateId], references: [taxRates.id] }),
  heroImage: one(mediaAssets, {
    fields: [events.heroImageAssetId],
    references: [mediaAssets.id],
  }),
  ticketTemplate: one(ticketTemplates, {
    fields: [events.ticketTemplateId],
    references: [ticketTemplates.id],
  }),
  clonedFrom: one(events, {
    fields: [events.clonedFromId],
    references: [events.id],
    relationName: 'event_clone',
  }),
  priceCategories: many(priceCategories),
  ticketTypes: many(ticketTypes),
  fees: many(fees),
  signingKeys: many(eventSigningKeys),
  accessCodes: many(accessCodes),
  queueAnnouncements: many(queueAnnouncements),
  orderItems: many(orderItems),
  scannerDevices: many(scannerDeviceEvents),
}));

export const priceCategoriesRelations = relations(priceCategories, ({ one, many }) => ({
  event: one(events, { fields: [priceCategories.eventId], references: [events.id] }),
  ticketTemplate: one(ticketTemplates, {
    fields: [priceCategories.ticketTemplateId],
    references: [ticketTemplates.id],
  }),
  seats: many(seats),
  ticketTypes: many(priceCategoryTicketTypes),
}));

export const ticketTypesRelations = relations(ticketTypes, ({ one, many }) => ({
  event: one(events, { fields: [ticketTypes.eventId], references: [events.id] }),
  priceCategories: many(priceCategoryTicketTypes),
}));

export const priceCategoryTicketTypesRelations = relations(priceCategoryTicketTypes, ({ one }) => ({
  priceCategory: one(priceCategories, {
    fields: [priceCategoryTicketTypes.priceCategoryId],
    references: [priceCategories.id],
  }),
  ticketType: one(ticketTypes, {
    fields: [priceCategoryTicketTypes.ticketTypeId],
    references: [ticketTypes.id],
  }),
}));

export const feesRelations = relations(fees, ({ one }) => ({
  event: one(events, { fields: [fees.eventId], references: [events.id] }),
  overrides: one(fees, {
    fields: [fees.overridesFeeId],
    references: [fees.id],
    relationName: 'fee_override',
  }),
  taxRate: one(taxRates, { fields: [fees.taxRateId], references: [taxRates.id] }),
}));

export const eventSigningKeysRelations = relations(eventSigningKeys, ({ one }) => ({
  event: one(events, { fields: [eventSigningKeys.eventId], references: [events.id] }),
}));

export const queueConfigsRelations = relations(queueConfigs, ({ one }) => ({
  event: one(events, { fields: [queueConfigs.eventId], references: [events.id] }),
}));

export const queueAnnouncementsRelations = relations(queueAnnouncements, ({ one }) => ({
  event: one(events, { fields: [queueAnnouncements.eventId], references: [events.id] }),
}));

export const accessCodesRelations = relations(accessCodes, ({ one, many }) => ({
  event: one(events, { fields: [accessCodes.eventId], references: [events.id] }),
  redemptions: many(accessCodeRedemptions),
}));

export const accessCodeRedemptionsRelations = relations(accessCodeRedemptions, ({ one }) => ({
  accessCode: one(accessCodes, {
    fields: [accessCodeRedemptions.accessCodeId],
    references: [accessCodes.id],
  }),
  order: one(orders, { fields: [accessCodeRedemptions.orderId], references: [orders.id] }),
}));

// ─── Orders ─────────────────────────────────────────────────────────────────
export const customersRelations = relations(customers, ({ many }) => ({
  orders: many(orders),
  sessions: many(customerSessions),
  tokens: many(customerTokens),
}));

export const customerSessionsRelations = relations(customerSessions, ({ one }) => ({
  customer: one(customers, { fields: [customerSessions.customerId], references: [customers.id] }),
}));

export const customerTokensRelations = relations(customerTokens, ({ one }) => ({
  customer: one(customers, { fields: [customerTokens.customerId], references: [customers.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  items: many(orderItems),
  fees: many(orderFees),
  tickets: many(tickets),
  payments: many(payments),
  refunds: many(refunds),
  invoices: many(invoices),
  history: many(orderHistory),
  allocations: many(bankTransactionAllocations),
  emails: many(emailMessages),
}));

export const orderItemsRelations = relations(orderItems, ({ one, many }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  event: one(events, { fields: [orderItems.eventId], references: [events.id] }),
  seat: one(seats, { fields: [orderItems.seatId], references: [seats.id] }),
  section: one(seatMapSections, {
    fields: [orderItems.sectionId],
    references: [seatMapSections.id],
  }),
  priceCategory: one(priceCategories, {
    fields: [orderItems.priceCategoryId],
    references: [priceCategories.id],
  }),
  ticketType: one(ticketTypes, {
    fields: [orderItems.ticketTypeId],
    references: [ticketTypes.id],
  }),
  accessCode: one(accessCodes, {
    fields: [orderItems.accessCodeId],
    references: [accessCodes.id],
  }),
  tickets: many(tickets),
}));

export const orderFeesRelations = relations(orderFees, ({ one }) => ({
  order: one(orders, { fields: [orderFees.orderId], references: [orders.id] }),
  event: one(events, { fields: [orderFees.eventId], references: [events.id] }),
  fee: one(fees, { fields: [orderFees.feeId], references: [fees.id] }),
}));

export const ticketsRelations = relations(tickets, ({ one, many }) => ({
  order: one(orders, { fields: [tickets.orderId], references: [orders.id] }),
  orderItem: one(orderItems, { fields: [tickets.orderItemId], references: [orderItems.id] }),
  event: one(events, { fields: [tickets.eventId], references: [events.id] }),
  signingKey: one(eventSigningKeys, {
    fields: [tickets.signingKeyId],
    references: [eventSigningKeys.id],
  }),
  replacedBy: one(tickets, {
    fields: [tickets.replacedByTicketId],
    references: [tickets.id],
    relationName: 'ticket_replacement',
  }),
  firstCheckedInDevice: one(scannerDevices, {
    fields: [tickets.firstCheckedInDeviceId],
    references: [scannerDevices.id],
  }),
  checkIns: many(checkInLogs),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
  bankTransaction: one(bankTransactions, {
    fields: [payments.bankTransactionId],
    references: [bankTransactions.id],
  }),
}));

export const refundsRelations = relations(refunds, ({ one, many }) => ({
  order: one(orders, { fields: [refunds.orderId], references: [orders.id] }),
  payment: one(payments, { fields: [refunds.paymentId], references: [payments.id] }),
  creditNote: one(invoices, { fields: [refunds.creditNoteId], references: [invoices.id] }),
  items: many(refundItems),
}));

export const refundItemsRelations = relations(refundItems, ({ one }) => ({
  refund: one(refunds, { fields: [refundItems.refundId], references: [refunds.id] }),
  orderItem: one(orderItems, { fields: [refundItems.orderItemId], references: [orderItems.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  order: one(orders, { fields: [invoices.orderId], references: [orders.id] }),
  corrects: one(invoices, {
    fields: [invoices.correctsInvoiceId],
    references: [invoices.id],
    relationName: 'invoice_correction',
  }),
  lines: many(invoiceLines),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
}));

export const orderHistoryRelations = relations(orderHistory, ({ one }) => ({
  order: one(orders, { fields: [orderHistory.orderId], references: [orders.id] }),
}));

// ─── Banking ────────────────────────────────────────────────────────────────
export const bankAccountsRelations = relations(bankAccounts, ({ many }) => ({
  connections: many(bankConnections),
  imports: many(bankStatementImports),
  transactions: many(bankTransactions),
}));

export const bankConnectionsRelations = relations(bankConnections, ({ one, many }) => ({
  bankAccount: one(bankAccounts, {
    fields: [bankConnections.bankAccountId],
    references: [bankAccounts.id],
  }),
  syncRuns: many(bankSyncRuns),
  tanChallenges: many(bankTanChallenges),
}));

export const bankSyncRunsRelations = relations(bankSyncRuns, ({ one }) => ({
  connection: one(bankConnections, {
    fields: [bankSyncRuns.connectionId],
    references: [bankConnections.id],
  }),
}));

export const bankTanChallengesRelations = relations(bankTanChallenges, ({ one }) => ({
  connection: one(bankConnections, {
    fields: [bankTanChallenges.connectionId],
    references: [bankConnections.id],
  }),
  syncRun: one(bankSyncRuns, {
    fields: [bankTanChallenges.syncRunId],
    references: [bankSyncRuns.id],
  }),
}));

export const bankStatementImportsRelations = relations(bankStatementImports, ({ one, many }) => ({
  bankAccount: one(bankAccounts, {
    fields: [bankStatementImports.bankAccountId],
    references: [bankAccounts.id],
  }),
  transactions: many(bankTransactions),
}));

export const bankTransactionsRelations = relations(bankTransactions, ({ one, many }) => ({
  bankAccount: one(bankAccounts, {
    fields: [bankTransactions.bankAccountId],
    references: [bankAccounts.id],
  }),
  import: one(bankStatementImports, {
    fields: [bankTransactions.importId],
    references: [bankStatementImports.id],
  }),
  allocations: many(bankTransactionAllocations),
}));

export const bankTransactionAllocationsRelations = relations(
  bankTransactionAllocations,
  ({ one }) => ({
    transaction: one(bankTransactions, {
      fields: [bankTransactionAllocations.bankTransactionId],
      references: [bankTransactions.id],
    }),
    order: one(orders, {
      fields: [bankTransactionAllocations.orderId],
      references: [orders.id],
    }),
    payment: one(payments, {
      fields: [bankTransactionAllocations.paymentId],
      references: [payments.id],
    }),
  }),
);

// ─── Templates & communication ──────────────────────────────────────────────
export const ticketTemplatesRelations = relations(ticketTemplates, ({ one }) => ({
  event: one(events, { fields: [ticketTemplates.eventId], references: [events.id] }),
  background: one(mediaAssets, {
    fields: [ticketTemplates.backgroundAssetId],
    references: [mediaAssets.id],
  }),
}));

export const walletPassDesignsRelations = relations(walletPassDesigns, ({ one }) => ({
  event: one(events, { fields: [walletPassDesigns.eventId], references: [events.id] }),
}));

export const emailTemplatesRelations = relations(emailTemplates, ({ one }) => ({
  event: one(events, { fields: [emailTemplates.eventId], references: [events.id] }),
}));

export const emailMessagesRelations = relations(emailMessages, ({ one }) => ({
  order: one(orders, { fields: [emailMessages.orderId], references: [orders.id] }),
}));

// ─── Check-in ───────────────────────────────────────────────────────────────
export const scannerDevicesRelations = relations(scannerDevices, ({ many }) => ({
  events: many(scannerDeviceEvents),
  checkIns: many(checkInLogs),
}));

export const scannerDeviceEventsRelations = relations(scannerDeviceEvents, ({ one }) => ({
  device: one(scannerDevices, {
    fields: [scannerDeviceEvents.deviceId],
    references: [scannerDevices.id],
  }),
  event: one(events, { fields: [scannerDeviceEvents.eventId], references: [events.id] }),
  entrance: one(seatMapEntrances, {
    fields: [scannerDeviceEvents.entranceId],
    references: [seatMapEntrances.id],
  }),
}));

export const checkInLogsRelations = relations(checkInLogs, ({ one }) => ({
  event: one(events, { fields: [checkInLogs.eventId], references: [events.id] }),
  ticket: one(tickets, { fields: [checkInLogs.ticketId], references: [tickets.id] }),
  device: one(scannerDevices, { fields: [checkInLogs.deviceId], references: [scannerDevices.id] }),
}));
