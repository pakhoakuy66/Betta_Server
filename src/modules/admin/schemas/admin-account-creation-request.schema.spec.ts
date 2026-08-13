import { describe, expect, it } from '@jest/globals';
import { model, Types } from 'mongoose';
import {
  ADMIN_ACCOUNT_CREATION_IDEMPOTENCY_INDEX,
  ADMIN_ACCOUNT_CREATION_TTL_INDEX,
  AdminAccountCreationRequest,
  AdminAccountCreationRequestSchema,
} from './admin-account-creation-request.schema';

const RequestModel = model<AdminAccountCreationRequest>(
  'AdminAccountCreationRequestUnit',
  AdminAccountCreationRequestSchema,
);

describe('AdminAccountCreationRequestSchema', () => {
  it('stores only hashed idempotency material and secret reference metadata', () => {
    const request = new RequestModel({
      idempotencyHash: 'a'.repeat(64),
      requestFingerprint: 'b'.repeat(64),
      actorPublicId: 'adm_23456789ABCD',
      actorSessionPublicId: 'ases_23456789ABCDEFGHJKLMNPQR',
      targetAdminAccountId: new Types.ObjectId(),
      targetAdminPublicId: 'adm_3456789ABCDE',
      secretReference: 'sm://betta/admin-activation/versions/1',
      activationExpiresAt: new Date(Date.now() + 900_000),
      idempotencyExpiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(request.validateSync()).toBeUndefined();
    for (const field of [
      'idempotencyHash',
      'requestFingerprint',
      'targetAdminAccountId',
      'secretReference',
    ]) {
      expect(AdminAccountCreationRequestSchema.path(field).options.select).toBe(
        false,
      );
    }
  });

  it('defines a unique idempotency index and absolute TTL cleanup', () => {
    const indexes = AdminAccountCreationRequestSchema.indexes();
    expect(indexes).toContainEqual([
      { idempotencyHash: 1 },
      expect.objectContaining({
        name: ADMIN_ACCOUNT_CREATION_IDEMPOTENCY_INDEX,
        unique: true,
      }),
    ]);
    expect(indexes).toContainEqual([
      { idempotencyExpiresAt: 1 },
      expect.objectContaining({
        name: ADMIN_ACCOUNT_CREATION_TTL_INDEX,
        expireAfterSeconds: 0,
      }),
    ]);
  });
});
