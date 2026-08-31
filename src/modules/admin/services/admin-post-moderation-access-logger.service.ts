import { Injectable, Logger } from '@nestjs/common';
import { ADMIN_POST_MODERATION_DETAIL_ACCESSED_EVENT } from '../constants/admin-post-moderation-detail.constants';
import { type AdminPostModerationTargetState } from '../interfaces/admin-post-moderation-detail.interface';

@Injectable()
export class AdminPostModerationAccessLogger {
  private readonly logger = new Logger('AdminPostModerationSecurityAccess');

  logDetail(
    input: Readonly<{
      actorPublicId: string;
      reportPublicId: string;
      targetState: AdminPostModerationTargetState;
      mediaCount: number;
      redactedMediaCount: number;
    }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        eventCode: ADMIN_POST_MODERATION_DETAIL_ACCESSED_EVENT,
        operation: 'VIEW_POST_MODERATION_DETAIL',
        actorPublicId: input.actorPublicId,
        reportPublicId: input.reportPublicId,
        targetState: input.targetState,
        mediaCount: input.mediaCount,
        redactedMediaCount: input.redactedMediaCount,
      }),
    );
  }
}
