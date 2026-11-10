import * as E from '@tix/shared';
import { pgEnum } from 'drizzle-orm/pg-core';

/** PostgreSQL enum types – values come from `@tix/shared/enums` (single source of truth). */

export const adminRoleEnum = pgEnum('admin_role', E.ADMIN_ROLES);
export const actorTypeEnum = pgEnum('actor_type', E.ACTOR_TYPES);
export const customerTokenPurposeEnum = pgEnum('customer_token_purpose', E.CUSTOMER_TOKEN_PURPOSES);
export const mediaAssetKindEnum = pgEnum('media_asset_kind', E.MEDIA_ASSET_KINDS);

export const seatMapKindEnum = pgEnum('seat_map_kind', E.SEAT_MAP_KINDS);
export const sectionTypeEnum = pgEnum('section_type', E.SECTION_TYPES);
export const symbolKindEnum = pgEnum('symbol_kind', E.SYMBOL_KINDS);
export const seatMapElementTypeEnum = pgEnum('seat_map_element_type', E.SEAT_MAP_ELEMENT_TYPES);
export const seatBlockReasonEnum = pgEnum('seat_block_reason', E.SEAT_BLOCK_REASONS);
export const seatFeatureEnum = pgEnum('seat_feature', E.SEAT_FEATURES);

export const eventStatusEnum = pgEnum('event_status', E.EVENT_STATUSES);
export const discountKindEnum = pgEnum('discount_kind', E.DISCOUNT_KINDS);
export const feeScopeEnum = pgEnum('fee_scope', E.FEE_SCOPES);
export const feeCalculationEnum = pgEnum('fee_calculation', E.FEE_CALCULATIONS);
export const salesChannelEnum = pgEnum('sales_channel', E.SALES_CHANNELS);
export const signingKeyStatusEnum = pgEnum('signing_key_status', E.SIGNING_KEY_STATUSES);

export const queueModeEnum = pgEnum('queue_mode', E.QUEUE_MODES);
export const queueAdmissionOrderEnum = pgEnum('queue_admission_order', E.QUEUE_ADMISSION_ORDERS);
export const announcementSeverityEnum = pgEnum('announcement_severity', E.ANNOUNCEMENT_SEVERITIES);
export const accessCodeTypeEnum = pgEnum('access_code_type', E.ACCESS_CODE_TYPES);

export const orderStatusEnum = pgEnum('order_status', E.ORDER_STATUSES);
export const orderItemKindEnum = pgEnum('order_item_kind', E.ORDER_ITEM_KINDS);
export const orderItemStatusEnum = pgEnum('order_item_status', E.ORDER_ITEM_STATUSES);
export const paymentMethodEnum = pgEnum('payment_method', E.PAYMENT_METHODS);
export const paymentStatusEnum = pgEnum('payment_status', E.PAYMENT_STATUSES);
export const refundKindEnum = pgEnum('refund_kind', E.REFUND_KINDS);
export const refundStatusEnum = pgEnum('refund_status', E.REFUND_STATUSES);
export const adjustmentKindEnum = pgEnum('adjustment_kind', E.ADJUSTMENT_KINDS);
export const adjustmentStatusEnum = pgEnum('adjustment_status', E.ADJUSTMENT_STATUSES);
export const invoiceTypeEnum = pgEnum('invoice_type', E.INVOICE_TYPES);
export const webhookEventStatusEnum = pgEnum('webhook_event_status', E.WEBHOOK_EVENT_STATUSES);

export const ticketStatusEnum = pgEnum('ticket_status', E.TICKET_STATUSES);
export const checkInStateEnum = pgEnum('check_in_state', E.CHECK_IN_STATES);
export const scanActionEnum = pgEnum('scan_action', E.SCAN_ACTIONS);
export const scanSourceEnum = pgEnum('scan_source', E.SCAN_SOURCES);
export const scanResultEnum = pgEnum('scan_result', E.SCAN_RESULTS);
export const scanWarningEnum = pgEnum('scan_warning', E.SCAN_WARNINGS);

export const bankAdapterEnum = pgEnum('bank_adapter', E.BANK_ADAPTERS);
export const bankSyncTriggerEnum = pgEnum('bank_sync_trigger', E.BANK_SYNC_TRIGGERS);
export const bankSyncStatusEnum = pgEnum('bank_sync_status', E.BANK_SYNC_STATUSES);
export const tanChallengeStatusEnum = pgEnum('tan_challenge_status', E.TAN_CHALLENGE_STATUSES);
export const bankStatementFormatEnum = pgEnum('bank_statement_format', E.BANK_STATEMENT_FORMATS);
export const bankImportSourceEnum = pgEnum('bank_import_source', E.BANK_IMPORT_SOURCES);
export const bankImportStatusEnum = pgEnum('bank_import_status', E.BANK_IMPORT_STATUSES);
export const bankTxMatchStatusEnum = pgEnum('bank_tx_match_status', E.BANK_TX_MATCH_STATUSES);
export const bankTxReviewReasonEnum = pgEnum('bank_tx_review_reason', E.BANK_TX_REVIEW_REASONS);
export const allocationMethodEnum = pgEnum('allocation_method', E.ALLOCATION_METHODS);

export const emailTemplateKeyEnum = pgEnum('email_template_key', E.EMAIL_TEMPLATE_KEYS);
export const emailStatusEnum = pgEnum('email_status', E.EMAIL_STATUSES);
