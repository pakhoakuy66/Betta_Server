import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { PostModerationState } from '../../posts/schemas/post.schema';
import { AdminRole } from '../constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
} from '../constants/admin-audit.constants';
import {
  AdminModerationHistoryResource,
  AdminModerationHistoryTargetAvailability,
  AdminModerationHistoryTargetType,
} from '../constants/admin-moderation-history.constants';
import { AdminModerationHistoryService } from './admin-moderation-history.service';

const queryChain = (result: unknown) => {
  const query = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(result)),
  };
  query.sort.mockReturnValue(query);
  query.skip.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
};

const findOneChain = (result: unknown) => {
  const query = {
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(result)),
  };
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
};

const existsChain = (result: unknown) => ({
  exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(result)),
});

const stored = (
  id: string,
  occurredAt: string,
  action = AdminAuditAction.USER_SUSPENDED,
) => ({
  publicId: id,
  action,
  outcome: AdminAuditOutcome.SUCCEEDED,
  actor: {
    type: AdminAuditActorType.ADMIN_ACCOUNT,
    publicId: 'adm_23456789ABCD',
    role: AdminRole.ADMIN,
    username: 'must-not-leak',
    displayName: 'Must Not Leak',
  },
  target: {
    publicId: 'usr_23456789AB',
    displayName: 'must-not-leak',
  },
  reasonCode: 'moderation_policy',
  reasonNote: 'must-not-leak@example.com',
  metadata: {
    beforeVersion: 2,
    afterVersion: 3,
    beforeState: 'ACTIVE',
    afterState: 'TEMPORARY_SUSPENSION',
    beforeAssigneePublicId: 'adm_23456789ABCE',
  },
  correlationId: 'corr_2026083000000001',
  occurredAt: new Date(occurredAt),
  adminNote: 'must-not-leak',
  evidence: { url: 'https://res.cloudinary.com/must-not-leak' },
});

const createService = (options: {
  records: readonly unknown[];
  historyExists?: unknown;
  user?: unknown;
  post?: unknown;
  reportExists?: unknown;
  systemReportExists?: unknown;
}) => {
  const historyQuery = queryChain(options.records);
  const auditEvents = {
    find: jest.fn<(filter: unknown) => typeof historyQuery>(() => historyQuery),
    exists: jest.fn(() => existsChain(options.historyExists ?? null)),
  };
  const users = {
    findOne: jest.fn(() => findOneChain(options.user ?? null)),
  };
  const posts = {
    findOne: jest.fn(() => findOneChain(options.post ?? null)),
  };
  const reports = {
    exists: jest.fn(() => existsChain(options.reportExists ?? null)),
  };
  const systemReports = {
    exists: jest.fn(() => existsChain(options.systemReportExists ?? null)),
  };
  return {
    historyQuery,
    auditEvents,
    service: new AdminModerationHistoryService(
      auditEvents as never,
      users as never,
      posts as never,
      reports as never,
      systemReports as never,
    ),
  };
};

describe('AdminModerationHistoryService', () => {
  it('returns the approved actor projection with Package A pagination', async () => {
    const fixture = createService({
      records: [
        stored('aaud_23456789ABCDEFGH', '2026-08-30T01:00:00.000Z'),
        stored('aaud_23456789ABCDEFGJ', '2026-08-29T01:00:00.000Z'),
        stored('aaud_23456789ABCDEFGK', '2026-08-28T01:00:00.000Z'),
      ],
      user: { isDeleted: false },
    });

    const result = await fixture.service.list({
      resource: AdminModerationHistoryResource.USER,
      targetPublicId: 'usr_23456789AB',
      page: 1,
      limit: 2,
    });

    expect(fixture.historyQuery.sort).toHaveBeenCalledWith({
      occurredAt: -1,
      publicId: 1,
    });
    expect(fixture.historyQuery.skip).toHaveBeenCalledWith(0);
    expect(fixture.historyQuery.select).toHaveBeenCalledWith(
      'publicId action outcome actor.type actor.publicId actor.role reasonCode metadata.beforeVersion metadata.afterVersion metadata.beforeState metadata.afterState correlationId occurredAt -_id',
    );
    expect(result.target).toEqual({
      type: AdminModerationHistoryTargetType.USER,
      publicId: 'usr_23456789AB',
      availability: AdminModerationHistoryTargetAvailability.AVAILABLE,
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      id: 'aaud_23456789ABCDEFGH',
      action: AdminAuditAction.USER_SUSPENDED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.ADMIN_ACCOUNT,
        publicId: 'adm_23456789ABCD',
        role: AdminRole.ADMIN,
      },
      reasonCode: 'moderation_policy',
      transition: {
        beforeVersion: 2,
        afterVersion: 3,
        beforeState: 'ACTIVE',
        afterState: 'TEMPORARY_SUSPENSION',
      },
      correlationId: 'corr_2026083000000001',
      occurredAt: '2026-08-30T01:00:00.000Z',
    });
    expect(result.pagination).toEqual({
      page: 1,
      limit: 2,
      hasMore: true,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /must-not-leak|adminNote|reasonNote|beforeAssignee|cloudinary|username|displayName|permission/iu,
    );
  });

  it('applies a bounded page offset and rejects an excessive offset', async () => {
    const fixture = createService({
      records: [stored('aaud_23456789ABCDEFGJ', '2026-08-29T01:00:00.000Z')],
      user: { isDeleted: false },
    });
    const page = await fixture.service.list({
      resource: AdminModerationHistoryResource.USER,
      targetPublicId: 'usr_23456789AB',
      page: 2,
      limit: 2,
    });
    expect(fixture.historyQuery.skip).toHaveBeenCalledWith(2);
    expect(page.pagination).toEqual({ page: 2, limit: 2, hasMore: false });

    await expect(
      fixture.service.list({
        resource: AdminModerationHistoryResource.USER,
        targetPublicId: 'usr_23456789AB',
        page: 102,
        limit: 100,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns retained history for a physically deleted Post', async () => {
    const fixture = createService({
      records: [
        stored(
          'aaud_23456789ABCDEFGH',
          '2026-08-30T01:00:00.000Z',
          AdminAuditAction.POST_DELETED,
        ),
      ],
      post: null,
    });

    const result = await fixture.service.list({
      resource: AdminModerationHistoryResource.POST,
      targetPublicId: 'post_23456789ABCD',
      page: 1,
      limit: 20,
    });

    expect(result.target.availability).toBe(
      AdminModerationHistoryTargetAvailability.DELETED,
    );
    expect(result.items[0]?.action).toBe(AdminAuditAction.POST_DELETED);
  });

  it('keeps a hidden Post available and maps srep to SYSTEM_REPORT', async () => {
    const postFixture = createService({
      records: [],
      post: {
        moderationState: PostModerationState.HIDDEN,
        isDeletedByAdmin: true,
      },
    });
    const postPage = await postFixture.service.list({
      resource: AdminModerationHistoryResource.POST,
      targetPublicId: 'post_23456789ABCD',
      page: 1,
      limit: 20,
    });
    expect(postPage.target.availability).toBe(
      AdminModerationHistoryTargetAvailability.AVAILABLE,
    );

    const reportFixture = createService({
      records: [
        {
          ...stored(
            'aaud_23456789ABCDEFGH',
            '2026-08-30T01:00:00.000Z',
            AdminAuditAction.SYSTEM_REPORT_TRANSITIONED,
          ),
          actor: {
            type: AdminAuditActorType.SYSTEM,
            publicId: 'adm_23456789ABCD',
            role: AdminRole.ADMIN,
          },
        },
      ],
      systemReportExists: { _id: 'internal' },
    });
    const reportPage = await reportFixture.service.list({
      resource: AdminModerationHistoryResource.REPORT,
      targetPublicId: 'srep_23456789ABCDEFGH',
      page: 1,
      limit: 20,
    });
    expect(reportPage.target.type).toBe(
      AdminModerationHistoryTargetType.SYSTEM_REPORT,
    );
    expect(reportPage.items[0]?.actor).toEqual({
      type: AdminAuditActorType.SYSTEM,
      publicId: null,
      role: null,
    });
  });

  it('returns 404 only when neither target nor retained history exists', async () => {
    const fixture = createService({ records: [], historyExists: null });

    await expect(
      fixture.service.list({
        resource: AdminModerationHistoryResource.USER,
        targetPublicId: 'usr_23456789AB',
        page: 1,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
