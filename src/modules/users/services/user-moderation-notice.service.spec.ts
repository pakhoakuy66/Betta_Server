import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import type { ClaimedOutboxEvent } from '../../../common/outbox/outbox.interface';
import { AdminUserRestrictionOperation } from '../../admin/constants/admin-user-restriction.constants';
import { UserRestrictionType } from '../constants/user-moderation.constants';
import {
  UserModerationNoticeAction,
  UserModerationNoticeStatus,
} from '../constants/user-moderation-notice.constants';
import { UserModerationNoticeService } from './user-moderation-notice.service';

const targetId = new Types.ObjectId();
const target = {
  _id: targetId,
  publicId: 'usr_23456789AB',
  isDeleted: false,
  status: 'active',
  version: 1,
  deletionOrigin: null,
  restriction: {
    type: UserRestrictionType.TEMPORARY_SUSPENSION,
    effectiveAt: new Date('2026-08-20T01:00:00.000Z'),
  },
};

const query = (result: unknown) => {
  const value = {
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(result)),
  };
  value.select.mockReturnValue(value);
  value.lean.mockReturnValue(value);
  return value;
};

const restrictionEvent = (
  operation: AdminUserRestrictionOperation,
): ClaimedOutboxEvent => ({
  publicId:
    operation === AdminUserRestrictionOperation.APPLY
      ? 'obx_23456789ABCDEFGHJKLMNP'
      : 'obx_3456789ABCDEFGHJKLMNPQ',
  schemaVersion: 1,
  eventType: 'moderation.user.restriction_changed',
  dedupeKey:
    operation === AdminUserRestrictionOperation.APPLY
      ? 'user-restriction:usr_23456789AB:1'
      : 'user-restriction:usr_23456789AB:2',
  aggregateType: 'user',
  aggregatePublicId: target.publicId,
  payload: {
    schemaVersion: 1,
    operation,
    userPublicId: target.publicId,
    restrictionType: UserRestrictionType.TEMPORARY_SUSPENSION,
    restriction:
      operation === AdminUserRestrictionOperation.APPLY
        ? {
            type: UserRestrictionType.TEMPORARY_SUSPENSION,
            effectiveAt: '2026-08-20T01:00:00.000Z',
            expiresAt: '2026-08-21T01:00:00.000Z',
            supportReference: 'sup_23456789ABCD',
          }
        : null,
    beforeVersion: 0,
    afterVersion: 1,
  },
  attempt: 1,
  occurredAt: new Date('2026-08-20T01:00:00.000Z'),
  completedHandlerIds: [],
});

const context = (userTarget: unknown = target) => {
  const users = { findOne: jest.fn(() => query(userTarget)) };
  const notices = {
    create: jest.fn<(documents: readonly unknown[]) => Promise<unknown[]>>(
      (documents) =>
        Promise.resolve([
          {
            ...(documents[0] as object),
            publicId: 'mnot_23456789ABCDEFGHJKLMNP',
          },
        ]),
    ),
    findOne: jest.fn(),
  };
  const notifications = {
    createSystemModerationNotification: jest.fn<
      (input: unknown) => Promise<void>
    >(() => Promise.resolve()),
  };
  const sessions = {
    updateMany: jest.fn<
      (
        filter: unknown,
        update: unknown,
      ) => {
        exec: () => Promise<{ modifiedCount: number }>;
      }
    >(() => ({
      exec: jest.fn(() => Promise.resolve({ modifiedCount: 1 })),
    })),
  };
  return {
    notices,
    notifications,
    sessions,
    service: new UserModerationNoticeService(
      notices as never,
      users as never,
      notifications as never,
      undefined,
      sessions as never,
    ),
  };
};

describe('UserModerationNoticeService', () => {
  it('reconciles restriction session revocation idempotently', async () => {
    const test = context();
    await test.service.reconcileSessionRevocation(
      restrictionEvent(AdminUserRestrictionOperation.APPLY),
    );

    expect(test.sessions.updateMany).toHaveBeenCalledWith(
      {
        userId: targetId,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: new Date('2026-08-20T01:00:00.000Z'),
          revokeReason: 'account_restricted',
        },
      },
    );
  });

  it('does not let a stale APPLY event revoke sessions after REMOVE', async () => {
    const test = context({
      ...target,
      version: 2,
      restriction: null,
    });

    await test.service.reconcileSessionRevocation(
      restrictionEvent(AdminUserRestrictionOperation.APPLY),
    );

    expect(test.sessions.updateMany).not.toHaveBeenCalled();
  });

  it('persists an active public notice without exposing internal moderation data', async () => {
    const test = context();
    await test.service.consumeRestrictionEvent(
      restrictionEvent(AdminUserRestrictionOperation.APPLY),
    );

    expect(test.notices.create).toHaveBeenCalledWith([
      expect.objectContaining({
        noticeType: 'SYSTEM_MODERATION',
        publicAction: UserModerationNoticeAction.TEMPORARY_SUSPENSION_APPLIED,
        status: UserModerationNoticeStatus.ACTIVE,
        supportReference: 'sup_23456789ABCD',
      }),
    ]);
    const serialized = JSON.stringify(test.notices.create.mock.calls[0]?.[0]);
    expect(serialized).not.toMatch(/actor|reasonNote|evidence|ObjectId/u);
    expect(
      test.notifications.createSystemModerationNotification,
    ).not.toHaveBeenCalled();
  });

  it('creates one mandatory Notification Center item when access is restored', async () => {
    const test = context();
    await test.service.consumeRestrictionEvent(
      restrictionEvent(AdminUserRestrictionOperation.REMOVE),
    );

    expect(
      test.notifications.createSystemModerationNotification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: targetId,
        action: UserModerationNoticeAction.TEMPORARY_SUSPENSION_REMOVED,
      }),
    );
  });

  it('fails closed for a malformed public payload', async () => {
    const test = context();
    const event = restrictionEvent(AdminUserRestrictionOperation.APPLY);

    await expect(
      test.service.consumeRestrictionEvent({
        ...event,
        payload: { ...event.payload, userPublicId: 'usr_wrong' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODERATION_EVENT' });
    expect(test.notices.create).not.toHaveBeenCalled();
  });
});
