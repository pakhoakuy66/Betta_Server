import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { ADMIN_LIFECYCLE_COORDINATOR_KEY } from '../constants/admin-lifecycle.constants';
import { AdminLastSuperAdminInvariantService } from './admin-last-super-admin-invariant.service';

const targetId = new Types.ObjectId();

const sessionQuery = (value: unknown) => ({
  session: jest.fn(() => Promise.resolve(value)),
});

const fixture = (
  anotherEffectiveSuperAdmin: unknown = { _id: new Types.ObjectId() },
) => {
  const accounts = {
    exists: jest.fn<(filter: unknown) => ReturnType<typeof sessionQuery>>(() =>
      sessionQuery(anotherEffectiveSuperAdmin),
    ),
  };
  const coordinators = {
    updateOne: jest.fn<
      (
        filter: unknown,
        update: unknown,
        options: unknown,
      ) => Promise<{ matchedCount: number }>
    >(() => Promise.resolve({ matchedCount: 1 })),
  };
  const service = new AdminLastSuperAdminInvariantService(
    accounts as never,
    coordinators as never,
  );
  const mongoSession = { inTransaction: () => true };
  return { service, accounts, coordinators, mongoSession };
};

describe('AdminLastSuperAdminInvariantService', () => {
  it('creates the singleton coordinator idempotently before a transaction', async () => {
    const f = fixture();
    await f.service.prepareCoordinator();
    expect(f.coordinators.updateOne).toHaveBeenCalledWith(
      { key: ADMIN_LIFECYCLE_COORDINATOR_KEY },
      { $setOnInsert: { key: ADMIN_LIFECYCLE_COORDINATOR_KEY, revision: 0 } },
      { upsert: true, runValidators: true },
    );
  });

  it('accepts a concurrent duplicate-key coordinator winner', async () => {
    const f = fixture();
    f.coordinators.updateOne.mockRejectedValueOnce({ code: 11000 });
    await expect(f.service.prepareCoordinator()).resolves.toBeUndefined();
  });

  it('requires an active caller transaction', async () => {
    const f = fixture();
    await expect(
      f.service.assertCanRemoveEffectiveAccess(targetId, {
        inTransaction: () => false,
      } as never),
    ).rejects.toBeInstanceOf(TypeError);
    expect(f.coordinators.updateOne).not.toHaveBeenCalled();
  });

  it('serializes first and then requires an effective SuperAdmin other than target', async () => {
    const f = fixture();
    await f.service.assertCanRemoveEffectiveAccess(
      targetId,
      f.mongoSession as never,
    );
    expect(f.coordinators.updateOne).toHaveBeenCalledWith(
      { key: ADMIN_LIFECYCLE_COORDINATOR_KEY },
      { $inc: { revision: 1 } },
      expect.objectContaining({ session: f.mongoSession }),
    );
    expect(f.accounts.exists).toHaveBeenCalledWith({
      _id: { $ne: targetId },
      role: AdminRole.SUPER_ADMIN,
      status: AdminAccountStatus.ACTIVE,
      mfaStatus: AdminMfaStatus.ACTIVE,
      mustChangePassword: false,
      lockedAt: null,
      deletedAt: null,
    });
  });

  it('rejects removal when no different effective SuperAdmin remains', async () => {
    const f = fixture(null);
    await expect(
      f.service.assertCanRemoveEffectiveAccess(
        targetId,
        f.mongoSession as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('fails closed when the coordinator is missing', async () => {
    const f = fixture();
    f.coordinators.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    await expect(
      f.service.assertCanRemoveEffectiveAccess(
        targetId,
        f.mongoSession as never,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.accounts.exists).not.toHaveBeenCalled();
  });
});
