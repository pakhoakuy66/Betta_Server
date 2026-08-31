import { describe, expect, it } from '@jest/globals';
import {
  buildReportQueueMetadata,
  REPORT_QUEUE_P0_DECISION_MS,
  REPORT_QUEUE_P0_TRIAGE_MS,
  REPORT_QUEUE_STANDARD_DECISION_MS,
  REPORT_QUEUE_STANDARD_TRIAGE_MS,
  ReportQueuePriority,
} from './report-queue.constants';
import {
  generateReportPublicId,
  isReportPublicId,
} from '../utils/generate-report-public-id';

describe('report queue constants', () => {
  const createdAt = new Date('2026-08-24T00:00:00.000Z');

  it('calculates the approved UTC SLA windows', () => {
    const standard = buildReportQueueMetadata(createdAt);
    const p0 = buildReportQueueMetadata(createdAt, ReportQueuePriority.P0);

    expect(standard.triageDueAt.getTime() - createdAt.getTime()).toBe(
      REPORT_QUEUE_STANDARD_TRIAGE_MS,
    );
    expect(standard.decisionDueAt.getTime() - createdAt.getTime()).toBe(
      REPORT_QUEUE_STANDARD_DECISION_MS,
    );
    expect(p0.triageDueAt.getTime() - createdAt.getTime()).toBe(
      REPORT_QUEUE_P0_TRIAGE_MS,
    );
    expect(p0.decisionDueAt.getTime() - createdAt.getTime()).toBe(
      REPORT_QUEUE_P0_DECISION_MS,
    );
  });

  it('generates opaque report public IDs', () => {
    const values = Array.from({ length: 100 }, generateReportPublicId);
    expect(values.every(isReportPublicId)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
    expect(isReportPublicId('507f1f77bcf86cd799439011')).toBe(false);
  });
});
