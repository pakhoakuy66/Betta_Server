import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { AdminRole } from '../constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
} from '../constants/admin-audit.constants';
import { AdminUserModerationHistoryService } from './admin-user-moderation-history.service';

const chain = (result: unknown) => {
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

describe('AdminUserModerationHistoryService', () => {
  it('returns only the internal allowlisted moderation projection', async () => {
    const stored = {
      publicId: 'aaud_23456789ABCDEFGH',
      action: AdminAuditAction.USER_SUSPENDED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.ADMIN_ACCOUNT,
        publicId: 'adm_23456789ABCD',
        role: AdminRole.ADMIN,
        username: 'must-not-leak',
      },
      reasonCode: 'moderation_policy',
      reasonNote: 'Internal moderation note',
      metadata: { beforeVersion: 3, afterVersion: 4 },
      occurredAt: new Date('2026-08-20T01:00:00.000Z'),
      correlationId: 'must-not-leak',
    };
    const findQuery = chain([stored]);
    const auditEvents = { find: jest.fn(() => findQuery) };
    const service = new AdminUserModerationHistoryService(
      auditEvents as never,
      {} as never,
    );

    const result = await service.list({
      targetPublicId: 'usr_23456789AB',
      page: 1,
      limit: 20,
    });

    expect(findQuery.select).toHaveBeenCalledWith(
      'publicId action outcome actor.type actor.publicId actor.role actor.displayName reasonCode reasonNote metadata occurredAt -_id',
    );
    expect(findQuery.sort).toHaveBeenCalledWith({
      occurredAt: -1,
      publicId: 1,
    });
    expect(result.items[0]).toEqual({
      id: stored.publicId,
      action: stored.action,
      outcome: stored.outcome,
      actor: { publicId: 'adm_23456789ABCD', role: AdminRole.ADMIN },
      reason: {
        code: 'moderation_policy',
        note: 'Internal moderation note',
      },
      transition: {
        beforeVersion: 3,
        afterVersion: 4,
        beforeState: null,
        afterState: null,
        affectedSessionCount: null,
      },
      occurredAt: '2026-08-20T01:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('returns a safe system actor for automatic expiry history', async () => {
    const stored = {
      publicId: 'aaud_23456789ABCDEFGH',
      action: 'moderation.user.unsuspended',
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.SYSTEM,
        displayName: 'Betta restriction expiry worker',
      },
      reasonCode: 'restriction_expired',
      metadata: {
        beforeVersion: 7,
        afterVersion: 8,
        beforeState: 'TEMPORARY_SUSPENSION',
        afterState: 'NONE',
        affectedSessionCount: 1,
      },
      occurredAt: new Date('2026-08-23T01:00:00.000Z'),
    };
    const service = new AdminUserModerationHistoryService(
      { find: jest.fn(() => chain([stored])) } as never,
      {} as never,
    );

    const result = await service.list({
      targetPublicId: 'usr_23456789AB',
      page: 1,
      limit: 20,
    });

    expect(result.items[0]?.actor).toEqual({
      type: AdminAuditActorType.SYSTEM,
      displayName: 'Betta restriction expiry worker',
    });
    expect(JSON.stringify(result)).not.toContain('username');
    expect(JSON.stringify(result)).not.toContain('permission');
  });

  it('returns 404 only when neither target nor retained history exists', async () => {
    const findQuery = chain([]);
    const existsQuery = { exec: jest.fn(() => Promise.resolve(null)) };
    const service = new AdminUserModerationHistoryService(
      {
        find: jest.fn(() => findQuery),
        exists: jest.fn(() => existsQuery),
      } as never,
      { exists: jest.fn(() => existsQuery) } as never,
    );

    await expect(
      service.list({
        targetPublicId: 'usr_23456789AB',
        page: 1,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
