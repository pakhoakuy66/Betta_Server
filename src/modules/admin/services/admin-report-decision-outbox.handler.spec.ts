import { describe, expect, it, jest } from '@jest/globals';
import type { ClaimedOutboxEvent } from '../../../common/outbox/outbox.interface';
import { ReportStatus } from '../../reports/schemas/report.schema';
import { AdminReportDecision } from '../constants/admin-report-decision.constants';
import { AdminReportDecisionOutboxHandler } from './admin-report-decision-outbox.handler';

const terminalAt = new Date('2026-09-01T00:00:00.000Z');
const event = (): ClaimedOutboxEvent => ({
  publicId: 'obx_23456789ABCDEFGHJKLMNP',
  schemaVersion: 1,
  eventType: 'moderation.report.decided',
  dedupeKey: 'report-decision:rpt_23456789ABCDEFGH:2',
  aggregateType: 'report',
  aggregatePublicId: 'rpt_23456789ABCDEFGH',
  payload: {
    schemaVersion: 1,
    reportPublicId: 'rpt_23456789ABCDEFGH',
    decision: AdminReportDecision.RESOLVE,
    targetAction: 'NONE',
    outcome: 'TARGET_EXPIRED_NO_ACTION',
    targetType: 'POST',
    targetPublicId: 'post_23456789ABCD',
    reportVersion: 2,
    terminalAt: terminalAt.toISOString(),
  },
  attempt: 1,
  occurredAt: terminalAt,
  completedHandlerIds: [],
});

const model = (value: unknown) => {
  const query = {
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn(() => Promise.resolve(value)),
  };
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return { findOne: jest.fn(() => query) };
};

describe('AdminReportDecisionOutboxHandler', () => {
  it('accepts the exact committed terminal report state', async () => {
    const handler = new AdminReportDecisionOutboxHandler(
      { register: jest.fn() } as never,
      model({
        status: ReportStatus.RESOLVED,
        version: 2,
        terminalAt,
      }) as never,
    );

    await expect(handler.handle(event())).resolves.toBeUndefined();
  });

  it('fails permanently when committed state does not match the event', async () => {
    const handler = new AdminReportDecisionOutboxHandler(
      { register: jest.fn() } as never,
      model({
        status: ReportStatus.REJECTED,
        version: 2,
        terminalAt,
      }) as never,
    );

    await expect(handler.handle(event())).rejects.toMatchObject({
      code: 'REPORT_DECISION_RECONCILIATION_FAILED',
      retryable: false,
    });
  });
});
