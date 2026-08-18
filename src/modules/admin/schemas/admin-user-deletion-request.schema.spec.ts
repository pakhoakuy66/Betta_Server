import { describe, expect, it } from '@jest/globals';
import { model, Types } from 'mongoose';
import { UserDeletionOrigin } from '../../users/constants/user-moderation.constants';
import { AdminUserDeletionOperation } from '../constants/admin-user-deletion.constants';
import {
  ADMIN_USER_DELETION_IDEMPOTENCY_INDEX,
  ADMIN_USER_DELETION_TTL_INDEX,
  AdminUserDeletionRequest,
  AdminUserDeletionRequestSchema,
} from './admin-user-deletion-request.schema';

const RequestModel = model<AdminUserDeletionRequest>(
  'AdminUserDeletionRequestUnit',
  AdminUserDeletionRequestSchema,
);

describe('AdminUserDeletionRequestSchema', () => {
  it('stores hashes and an immutable public replay result', () => {
    const now = new Date();
    const request = new RequestModel({
      idempotencyHash: 'a'.repeat(64),
      requestFingerprint: 'b'.repeat(64),
      actorPublicId: 'adm_23456789ABCD',
      actorSessionPublicId: 'ases_23456789ABCDEFGHJKLMNPQR',
      targetUserId: new Types.ObjectId(),
      targetPublicId: 'usr_23456789AB',
      operation: AdminUserDeletionOperation.DELETE,
      resultVersion: 1,
      resultIsDeleted: true,
      resultDeletionOrigin: UserDeletionOrigin.ADMIN_MODERATION,
      resultDeletedAt: now,
      resultRestorableUntil: new Date(now.getTime() + 86_400_000),
      resultUpdatedAt: now,
      revokedSessionCount: 2,
      idempotencyExpiresAt: new Date(now.getTime() + 86_400_000),
    });

    expect(request.validateSync()).toBeUndefined();
    for (const field of [
      'idempotencyHash',
      'requestFingerprint',
      'targetUserId',
    ]) {
      expect(AdminUserDeletionRequestSchema.path(field).options.select).toBe(
        false,
      );
    }
  });

  it('defines unique idempotency and absolute TTL indexes', () => {
    expect(AdminUserDeletionRequestSchema.indexes()).toContainEqual([
      { idempotencyHash: 1 },
      expect.objectContaining({
        name: ADMIN_USER_DELETION_IDEMPOTENCY_INDEX,
        unique: true,
      }),
    ]);
    expect(AdminUserDeletionRequestSchema.indexes()).toContainEqual([
      { idempotencyExpiresAt: 1 },
      expect.objectContaining({
        name: ADMIN_USER_DELETION_TTL_INDEX,
        expireAfterSeconds: 0,
      }),
    ]);
  });
});
