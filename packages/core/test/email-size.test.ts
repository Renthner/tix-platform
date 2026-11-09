import { describe, expect, it } from 'vitest';
import {
  encodedAttachmentBytes,
  estimateMessageBytes,
  exceedsMaxMessageSize,
} from '../src/email/size';

const MB = 1024 * 1024;

describe('e-mail size estimate', () => {
  it('expands attachments by base64 and line breaks', () => {
    const encoded = encodedAttachmentBytes(3_000_000);
    expect(encoded).toBeGreaterThan(4_000_000);
    expect(encoded).toBeLessThan(4_200_000);
  });

  it('adds all attachments and the body', () => {
    const one = estimateMessageBytes([1_000_000], 10_000);
    const two = estimateMessageBytes([1_000_000, 1_000_000], 10_000);
    expect(two - one).toBe(encodedAttachmentBytes(1_000_000));
    expect(estimateMessageBytes([], 5_000)).toBeGreaterThan(5_000);
  });

  it('compares against the configured limit in MB', () => {
    // 18 MB of PDF -> ~24.6 MB encoded: fits 25 MB, not 24 MB.
    const estimate = estimateMessageBytes([18 * MB], 20_000);
    expect(exceedsMaxMessageSize(estimate, 25)).toBe(false);
    expect(exceedsMaxMessageSize(estimate, 24)).toBe(true);
    expect(exceedsMaxMessageSize(estimate, 100)).toBe(false);
  });
});
