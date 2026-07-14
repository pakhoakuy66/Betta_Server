import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Report, ReportStatus } from '../schemas/report.schema';
import {
  RetentionCleanupStatus,
  SystemReport,
  SystemReportStatus,
} from '../schemas/system-report.schema';

const REPORT_TERMINAL_STATUSES = new Set<ReportStatus>([
  ReportStatus.RESOLVED,
  ReportStatus.REJECTED,
]);
const SYSTEM_REPORT_TERMINAL_STATUSES = new Set<SystemReportStatus>([
  SystemReportStatus.FIXED,
  SystemReportStatus.CLOSED,
]);

@Injectable()
export class ReportStatusTransitionService {
  constructor(
    @InjectModel(Report.name)
    private readonly reportModel: Model<Report>,
    @InjectModel(SystemReport.name)
    private readonly systemReportModel: Model<SystemReport>,
  ) {}

  async transitionReport(
    id: Types.ObjectId,
    nextStatus: ReportStatus,
  ): Promise<void> {
    const current = await this.reportModel
      .findById(id)
      .select('status terminalAt')
      .lean<{ status: ReportStatus; terminalAt?: Date | null }>()
      .exec();

    if (!current) throw new NotFoundException('Báo cáo không tồn tại');
    if (current.status === nextStatus) {
      throw new BadRequestException('Báo cáo đã ở trạng thái yêu cầu');
    }

    const result = await this.reportModel.updateOne(
      {
        _id: id,
        status: current.status,
        terminalAt: current.terminalAt ?? null,
      },
      {
        $set: {
          status: nextStatus,
          terminalAt: REPORT_TERMINAL_STATUSES.has(nextStatus)
            ? new Date()
            : null,
        },
      },
    );

    if (result.modifiedCount !== 1) {
      throw new BadRequestException(
        'Trạng thái báo cáo vừa thay đổi, hãy thử lại',
      );
    }
  }

  async transitionSystemReport(
    id: Types.ObjectId,
    nextStatus: SystemReportStatus,
  ): Promise<void> {
    const current = await this.systemReportModel
      .findById(id)
      .select('status terminalAt retentionCleanupStatus')
      .lean<{
        status: SystemReportStatus;
        terminalAt?: Date | null;
        retentionCleanupStatus?: RetentionCleanupStatus;
      }>()
      .exec();

    if (!current) throw new NotFoundException('Báo cáo sự cố không tồn tại');
    if (current.status === nextStatus) {
      throw new BadRequestException('Báo cáo sự cố đã ở trạng thái yêu cầu');
    }

    const cleanupStatus =
      current.retentionCleanupStatus ?? RetentionCleanupStatus.PENDING;
    if (cleanupStatus !== RetentionCleanupStatus.PENDING) {
      throw new BadRequestException(
        'Không thể đổi trạng thái khi retention cleanup đã bắt đầu',
      );
    }

    const result = await this.systemReportModel.updateOne(
      {
        _id: id,
        status: current.status,
        terminalAt: current.terminalAt ?? null,
        $or: [
          { retentionCleanupStatus: RetentionCleanupStatus.PENDING },
          { retentionCleanupStatus: { $exists: false } },
        ],
      },
      {
        $set: {
          status: nextStatus,
          terminalAt: SYSTEM_REPORT_TERMINAL_STATUSES.has(nextStatus)
            ? new Date()
            : null,
        },
      },
    );

    if (result.modifiedCount !== 1) {
      throw new BadRequestException(
        'Trạng thái báo cáo sự cố vừa thay đổi, hãy thử lại',
      );
    }
  }
}
