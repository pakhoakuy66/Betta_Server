import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { OutboxPermanentError } from '../../../common/outbox/outbox.errors';
import { OutboxHandlerRegistry } from '../../../common/outbox/outbox-handler.registry';
import type {
  ClaimedOutboxEvent,
  OutboxEventHandler,
} from '../../../common/outbox/outbox.interface';
import { REPORT_PUBLIC_ID_PATTERN } from '../../reports/constants/report-queue.constants';
import { Report, ReportStatus } from '../../reports/schemas/report.schema';
import {
  ADMIN_REPORT_DECISION_EVENT_TYPE,
  AdminReportDecision,
} from '../constants/admin-report-decision.constants';

type StoredTerminalReport = Readonly<{
  status: ReportStatus;
  version: number;
  terminalAt: Date | null;
}>;

@Injectable()
export class AdminReportDecisionOutboxHandler
  implements OutboxEventHandler, OnModuleInit
{
  readonly eventType = ADMIN_REPORT_DECISION_EVENT_TYPE;
  readonly handlerId = 'moderation.report.decision-reconcile.v1';
  readonly order = 100;

  constructor(
    private readonly registry: OutboxHandlerRegistry,
    @InjectModel(Report.name) private readonly reports: Model<Report>,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload;
    const terminalAt =
      typeof payload.terminalAt === 'string'
        ? new Date(payload.terminalAt)
        : null;
    if (
      event.schemaVersion !== 1 ||
      event.aggregateType !== 'report' ||
      !REPORT_PUBLIC_ID_PATTERN.test(event.aggregatePublicId) ||
      payload.schemaVersion !== 1 ||
      payload.reportPublicId !== event.aggregatePublicId ||
      (payload.decision !== AdminReportDecision.RESOLVE &&
        payload.decision !== AdminReportDecision.REJECT) ||
      !Number.isSafeInteger(payload.reportVersion) ||
      Number(payload.reportVersion) < 1 ||
      !terminalAt ||
      Number.isNaN(terminalAt.getTime())
    ) {
      throw new OutboxPermanentError(
        'INVALID_REPORT_DECISION_EVENT',
        'Report decision event không hợp lệ',
      );
    }

    const report = await this.reports
      .findOne({ publicId: event.aggregatePublicId })
      .select('status version terminalAt')
      .lean<StoredTerminalReport | null>()
      .exec();
    const expectedStatus =
      payload.decision === AdminReportDecision.RESOLVE
        ? ReportStatus.RESOLVED
        : ReportStatus.REJECTED;
    if (
      !report ||
      report.status !== expectedStatus ||
      report.version !== Number(payload.reportVersion) ||
      report.terminalAt?.getTime() !== terminalAt.getTime()
    ) {
      throw new OutboxPermanentError(
        'REPORT_DECISION_RECONCILIATION_FAILED',
        'Report decision không khớp committed state',
      );
    }
  }
}
