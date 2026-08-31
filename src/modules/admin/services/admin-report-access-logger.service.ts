import { Injectable, Logger } from '@nestjs/common';
import { ADMIN_REPORT_QUEUE_LIST_ACCESSED_EVENT } from '../constants/admin-report-queue.constants';

@Injectable()
export class AdminReportAccessLogger {
  private readonly logger = new Logger('AdminReportSecurityAccess');

  logList(
    input: Readonly<{ actorPublicId: string; resultCount: number }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        eventCode: ADMIN_REPORT_QUEUE_LIST_ACCESSED_EVENT,
        operation: 'LIST_REPORT_QUEUE',
        actorPublicId: input.actorPublicId,
        resultCount: input.resultCount,
      }),
    );
  }
}
