/** MIME overhead per part (boundary, Content-* headers) and for the message headers. */
const PART_OVERHEAD_BYTES = 2_048;

/** Size of `bytes` as a base64 MIME attachment (4/3 expansion + CRLF every 76 characters). */
export function encodedAttachmentBytes(bytes: number): number {
  return Math.ceil(Math.ceil(bytes / 3) * 4 * (78 / 76)) + PART_OVERHEAD_BYTES;
}

/** Estimated size of the encoded message: attachments plus rendered HTML and text body. */
export function estimateMessageBytes(
  attachmentSizes: readonly number[],
  bodyBytes: number,
): number {
  return (
    attachmentSizes.reduce((sum, size) => sum + encodedAttachmentBytes(size), 0) +
    bodyBytes +
    PART_OVERHEAD_BYTES
  );
}

/** True when the message exceeds `maxMessageSizeMb` (MB = 1024 * 1024 bytes). */
export function exceedsMaxMessageSize(estimatedBytes: number, maxMessageSizeMb: number): boolean {
  return estimatedBytes > maxMessageSizeMb * 1024 * 1024;
}
