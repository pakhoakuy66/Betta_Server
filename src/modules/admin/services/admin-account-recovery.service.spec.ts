import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  AdminAuditActorType,
  AdminAuditSource,
} from '../constants/admin-audit.constants';
import { AdminRecoveryPurpose } from '../constants/admin-account-recovery.constants';
import { AdminAccountRecoveryService } from './admin-account-recovery.service';

const query = <T>(value: T) => {
  const chain = {
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn<() => Promise<T>>().mockResolvedValue(value),
  };
  chain.select.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
};

describe('AdminAccountRecoveryService', () => {
  const target = {
    _id: new Types.ObjectId(),
    publicId: 'adm_23456789ABCD',
    username: 'root.admin',
    displayName: 'Root Admin',
    role: AdminRole.SUPER_ADMIN,
    status: AdminAccountStatus.LOCKED,
    mfaStatus: AdminMfaStatus.ACTIVE,
    credentialVersion: 2,
    authzVersion: 3,
    permissionVersion: 4,
    version: 5,
    activationGrantConsumedAt: new Date(),
  };
  let accounts: { findOne: jest.Mock; updateOne: jest.Mock };
  let grants: { updateMany: jest.Mock; create: jest.Mock };
  let secretStore: {
    assertReady: jest.Mock;
    putVersion: jest.Mock;
    revokeVersion: jest.Mock;
  };

  const createService = (transaction?: jest.Mock) =>
    new AdminAccountRecoveryService(
      accounts as never,
      grants as never,
      {
        transaction:
          transaction ??
          jest.fn((operation: (session: unknown) => unknown) =>
            Promise.resolve(operation({ inTransaction: () => true })),
          ),
      } as never,
      {
        environment: 'test',
        mfa: {
          algorithm: 'SHA1',
          digits: 6,
          periodSeconds: 30,
          acceptedPastSteps: 1,
          acceptedFutureSteps: 1,
          recoveryCodeCount: 10,
        },
      } as never,
      secretStore as never,
      {} as never,
      {
        assertAllowed: jest.fn<() => Promise<void>>().mockResolvedValue(),
        recordFailure: jest.fn<() => Promise<void>>().mockResolvedValue(),
        clearAccountFailuresInTransaction: jest
          .fn<() => Promise<void>>()
          .mockResolvedValue(),
      } as never,
      {} as never,
      { revokeAllInTransaction: jest.fn() } as never,
      { record: jest.fn() } as never,
    );

  beforeEach(() => {
    accounts = {
      findOne: jest.fn().mockReturnValue(query(target)),
      updateOne: jest
        .fn<(...args: unknown[]) => Promise<{ modifiedCount: number }>>()
        .mockResolvedValue({ modifiedCount: 1 }),
    };
    grants = {
      updateMany: jest
        .fn<(...args: unknown[]) => Promise<{ modifiedCount: number }>>()
        .mockResolvedValue({ modifiedCount: 0 }),
      create: jest
        .fn<(...args: unknown[]) => Promise<unknown[]>>()
        .mockResolvedValue([{ publicId: 'argr_test' }]),
    };
    secretStore = {
      assertReady: jest.fn(),
      putVersion: jest
        .fn<(...args: unknown[]) => Promise<string>>()
        .mockResolvedValue('sm://betta/admin-recovery/versions/1'),
      revokeVersion: jest
        .fn<(...args: unknown[]) => Promise<void>>()
        .mockResolvedValue(),
    };
  });

  it('denies self-reset and never writes a recovery secret', async () => {
    const service = createService();
    await expect(
      service.resetAdminMfa({
        actorAdminAccountId: target._id,
        actor: {
          type: AdminAuditActorType.ADMIN_ACCOUNT,
          publicId: target.publicId,
          username: target.username,
          displayName: target.displayName,
          role: AdminRole.SUPER_ADMIN,
          permissionVersion: 4,
        },
        actorSessionPublicId: 'ases_23456789ABCDEFGH',
        targetAdminPublicId: target.publicId,
        reauthGrant: 'A'.repeat(43),
        reasonCode: 'admin_mfa_reset_approved',
        source: AdminAuditSource.HTTP,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(secretStore.putVersion).not.toHaveBeenCalled();
  });

  it('dry-run reports only eligibility and writes no secret', async () => {
    const result = await createService().inspectBreakGlass({
      targetAdminPublicId: target.publicId,
      operatorReference: 'ops.primary',
      approvalReference: 'approval-20260811',
      correlationId: 'breakglass-20260811-0001',
    });
    expect(result).toEqual({
      eligible: true,
      targetAdminPublicId: target.publicId,
      currentStatus: AdminAccountStatus.LOCKED,
      currentMfaStatus: AdminMfaStatus.ACTIVE,
    });
    expect(secretStore.assertReady).not.toHaveBeenCalled();
    expect(secretStore.putVersion).not.toHaveBeenCalled();
  });

  it('rejects a pending-activation SuperAdmin without writing a secret', async () => {
    const pending = {
      ...target,
      status: AdminAccountStatus.PENDING_ACTIVATION,
      mfaStatus: AdminMfaStatus.NOT_ENROLLED,
      activationGrantConsumedAt: null,
    };
    accounts.findOne.mockReturnValue(query(pending));
    const input = {
      targetAdminPublicId: pending.publicId,
      operatorReference: 'ops.primary',
      approvalReference: 'approval-20260811',
      correlationId: 'breakglass-20260811-0001',
    };

    await expect(createService().inspectBreakGlass(input)).resolves.toEqual({
      eligible: false,
      targetAdminPublicId: pending.publicId,
      currentStatus: AdminAccountStatus.PENDING_ACTIVATION,
      currentMfaStatus: AdminMfaStatus.NOT_ENROLLED,
    });
    await expect(
      createService().executeBreakGlass(input),
    ).rejects.toMatchObject({ status: 409 });
    expect(secretStore.assertReady).not.toHaveBeenCalled();
    expect(secretStore.putVersion).not.toHaveBeenCalled();
    expect(accounts.updateOne).not.toHaveBeenCalled();
  });

  it('rejects a break-glass password above 72 UTF-8 bytes before bcrypt', async () => {
    accounts.findOne.mockReturnValue(
      query({
        ...target,
        status: AdminAccountStatus.ACTIVE,
        mfaStatus: AdminMfaStatus.RESET_REQUIRED,
      }),
    );
    await expect(
      createService().beginEnrollment({
        targetAdminPublicId: target.publicId,
        rawGrant: 'A'.repeat(43),
        purpose: AdminRecoveryPurpose.SUPER_ADMIN_BREAK_GLASS,
        newPassword: `A1#${'😀'.repeat(18)}`,
        accountLabel: 'root.admin',
        trustedClientIp: '203.0.113.10',
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(accounts.updateOne).not.toHaveBeenCalled();
  });

  it('revokes the Secret Manager version when MongoDB transaction fails', async () => {
    const service = createService(
      jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockRejectedValue(new Error('raw database detail')),
    );
    const operation = service.executeBreakGlass({
      targetAdminPublicId: target.publicId,
      operatorReference: 'ops.primary',
      approvalReference: 'approval-20260811',
      correlationId: 'breakglass-20260811-0001',
    });
    await expect(operation).rejects.toThrow(
      'Không thể hoàn tất Admin recovery',
    );
    expect(secretStore.revokeVersion).toHaveBeenCalledWith(
      'sm://betta/admin-recovery/versions/1',
    );
  });
});
