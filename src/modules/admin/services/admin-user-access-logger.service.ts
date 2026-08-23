import { Injectable, Logger } from '@nestjs/common';
import {
  ADMIN_USER_DETAIL_ACCESSED_EVENT,
  ADMIN_USER_LIST_ACCESSED_EVENT,
} from '../constants/admin-user-query.constants';
import { ADMIN_USER_MODERATION_HISTORY_ACCESSED_EVENT } from '../constants/admin-user-moderation-history.constants';

type ListAccessInput = Readonly<{
  actorPublicId: string;
  resultCount: number;
}>;

type DetailAccessInput = Readonly<{
  actorPublicId: string;
  targetPublicId: string;
}>;

type ModerationHistoryAccessInput = Readonly<{
  actorPublicId: string;
  targetPublicId: string;
  resultCount: number;
}>;

@Injectable()
export class AdminUserAccessLogger {
  private readonly logger = new Logger('AdminUserSecurityAccess');

  logList(input: ListAccessInput): void {
    this.logger.log(
      JSON.stringify({
        eventCode: ADMIN_USER_LIST_ACCESSED_EVENT,
        operation: 'LIST_USERS',
        actorPublicId: input.actorPublicId,
        resultCount: input.resultCount,
      }),
    );
  }

  logDetail(input: DetailAccessInput): void {
    this.logger.log(
      JSON.stringify({
        eventCode: ADMIN_USER_DETAIL_ACCESSED_EVENT,
        operation: 'VIEW_USER_DETAIL',
        actorPublicId: input.actorPublicId,
        targetPublicId: input.targetPublicId,
      }),
    );
  }

  logModerationHistory(input: ModerationHistoryAccessInput): void {
    this.logger.log(
      JSON.stringify({
        eventCode: ADMIN_USER_MODERATION_HISTORY_ACCESSED_EVENT,
        operation: 'VIEW_USER_MODERATION_HISTORY',
        actorPublicId: input.actorPublicId,
        targetPublicId: input.targetPublicId,
        resultCount: input.resultCount,
      }),
    );
  }
}
