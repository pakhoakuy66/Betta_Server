import { describe, expect, it, jest } from '@jest/globals';
import {
  ReportReasonGroup,
  ReportStatus,
} from '../../reports/schemas/report.schema';
import { AdminPermission } from '../constants/admin-permission.constants';
import { ADMIN_PERMISSIONS_METADATA } from '../decorators/require-admin-permissions.decorator';
import { AdminPostModerationTargetState } from '../interfaces/admin-post-moderation-detail.interface';
import { AdminPostModerationDetailController } from './admin-post-moderation-detail.controller';

describe('AdminPostModerationDetailController', () => {
  it('requires reports.view + posts.view and applies private response headers', async () => {
    const result = Object.freeze({
      reportPublicId: 'rpt_23456789ABCDEFGH',
      reportStatus: ReportStatus.PENDING,
      reason: Object.freeze({
        code: ReportReasonGroup.VIOLATION_CONTENT,
        group: ReportReasonGroup.VIOLATION_CONTENT,
        taxonomyVersion: null,
      }),
      target: Object.freeze({
        publicId: 'post_23456789ABCD',
        state: AdminPostModerationTargetState.AVAILABLE,
      }),
      evidence: Object.freeze({
        authorUsername: 'safe_author',
        content: 'immutable evidence',
        media: Object.freeze([]),
        createdAt: null,
        expireAt: null,
        evidenceUnavailable: false,
      }),
    });
    const detail = {
      getByReportPublicId: jest.fn<
        (publicId: string) => Promise<typeof result>
      >(() => Promise.resolve(result)),
    };
    const accessLogger = { logDetail: jest.fn() };
    const response = { setHeader: jest.fn() };
    const controller = new AdminPostModerationDetailController(
      detail as never,
      accessLogger as never,
    );

    await controller.getPostDetail(
      result.reportPublicId,
      { user: { publicId: 'adm_23456789ABCD' } } as never,
      response as never,
    );

    expect(
      Reflect.getMetadata(
        ADMIN_PERMISSIONS_METADATA,
        // Metadata is attached to this handler by the decorator.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        AdminPostModerationDetailController.prototype.getPostDetail,
      ),
    ).toEqual([AdminPermission.REPORTS_VIEW, AdminPermission.POSTS_VIEW]);
    expect(detail.getByReportPublicId).toHaveBeenCalledWith(
      result.reportPublicId,
    );
    expect(response.setHeader.mock.calls).toEqual(
      expect.arrayContaining([
        ['Cache-Control', 'no-store, max-age=0'],
        ['Pragma', 'no-cache'],
        ['Referrer-Policy', 'no-referrer'],
      ]),
    );
    expect(accessLogger.logDetail).toHaveBeenCalledWith({
      actorPublicId: 'adm_23456789ABCD',
      reportPublicId: result.reportPublicId,
      targetState: AdminPostModerationTargetState.AVAILABLE,
      mediaCount: 0,
      redactedMediaCount: 0,
    });
    expect(JSON.stringify(accessLogger.logDetail.mock.calls)).not.toContain(
      'immutable evidence',
    );
  });
});
