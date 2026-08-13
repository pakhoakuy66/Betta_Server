import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import {
  AdminAccountDeletionOrigin,
  AdminAccountStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { AdminAccountDeletionAction } from '../constants/admin-account-deletion.constants';
import { AdminAuditActorType } from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import { AdminSessionRevokeReason } from '../constants/admin-session.constants';
import { type AdminAccountDeletionActor } from '../interfaces/admin-account-deletion.interface';
import { AdminAccountDeletionService } from './admin-account-deletion.service';

const targetId = new Types.ObjectId();
const now = new Date('2026-08-13T00:00:00.000Z');

const actor = (
  permission: AdminPermission = AdminPermission.ADMINS_DELETE,
): AdminAccountDeletionActor => ({
  type: AdminAuditActorType.ADMIN_ACCOUNT,
  adminAccountId: new Types.ObjectId(),
  publicId: 'adm_23456789ABCD',
  username: 'root.admin',
  displayName: 'Root Admin',
  role: AdminRole.SUPER_ADMIN,
  permission,
  permissionVersion: 1,
  sessionPublicId: 'ases_23456789ABCDEFGHJKLMNPQR',
  credentialVersion: 1,
  authzVersion: 1,
});

const target = (
  role = AdminRole.ADMIN,
  status = AdminAccountStatus.ACTIVE,
) => ({
  _id: targetId,
  publicId: 'adm_3456789ABCDE',
  displayName: 'Managed Admin',
  role,
  status,
  version: 5,
  authzVersion: 3,
  lockedAt: status === AdminAccountStatus.LOCKED ? now : null,
  deletedAt: status === AdminAccountStatus.SOFT_DELETED ? now : null,
  deletionOrigin:
    status === AdminAccountStatus.SOFT_DELETED
      ? AdminAccountDeletionOrigin.ADMIN
      : null,
  updatedAt: now,
});

const query = (value: unknown) => {
  const result = {
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(value)),
  };
  result.select.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  return result;
};

const sessionQuery = (value: unknown) => ({
  session: jest.fn(() => Promise.resolve(value)),
});

const fixture = (
  stored = target(),
  updated: ReturnType<typeof target> = {
    ...target(),
    status: AdminAccountStatus.SOFT_DELETED,
    version: 6,
    authzVersion: 4,
    deletedAt: now,
    deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
  },
  anotherEffectiveSuperAdmin = true,
) => {
  const mongoSession = { inTransaction: () => true };
  const accounts = {
    findOne: jest.fn(() => query(stored)),
    findOneAndUpdate: jest.fn<
      (
        filter: unknown,
        update: unknown,
        options: unknown,
      ) => ReturnType<typeof query>
    >(() => query(updated)),
    exists: jest.fn(() => sessionQuery(true)),
  };
  const sessions = { exists: jest.fn(() => sessionQuery(true)) };
  const connection = {
    transaction: jest.fn((operation: (session: unknown) => unknown) =>
      Promise.resolve(operation(mongoSession)),
    ),
  };
  const reauth = {
    issue: jest.fn<(input: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ grant: 'R'.repeat(43), expiresAt: now }),
    ),
    consumeInTransaction: jest.fn(() => Promise.resolve()),
  };
  const lastSuperAdmin = {
    prepareCoordinator: jest.fn<() => Promise<void>>(() => Promise.resolve()),
    assertCanRemoveEffectiveAccess: jest.fn<
      (targetAdminAccountId: Types.ObjectId, session: unknown) => Promise<void>
    >(() =>
      anotherEffectiveSuperAdmin
        ? Promise.resolve()
        : Promise.reject(new ConflictException('last SuperAdmin')),
    ),
  };
  const sessionService = {
    revokeAllInTransaction: jest.fn<(input: unknown) => Promise<number>>(() =>
      Promise.resolve(2),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve('aaud_public')) };
  const service = new AdminAccountDeletionService(
    accounts as never,
    sessions as never,
    connection as never,
    lastSuperAdmin as never,
    reauth as never,
    sessionService as never,
    audit as never,
  );
  return {
    service,
    accounts,
    lastSuperAdmin,
    connection,
    reauth,
    sessionService,
    audit,
  };
};

const mutation = (overrides: Record<string, unknown> = {}) => ({
  actor: actor(),
  targetPublicId: 'adm_3456789ABCDE',
  action: AdminAccountDeletionAction.SOFT_DELETE,
  expectedVersion: 5,
  reasonCode: 'security_offboarding',
  reasonNote: 'Approved administrative offboarding',
  correlationId: 'admin-delete-20260813-0001',
  ...overrides,
});

describe('AdminAccountDeletionService', () => {
  it('rejects self-action and non-SuperAdmin actors before DB access', async () => {
    const f = fixture();
    await expect(
      f.service.updateDeletion({
        ...mutation(),
        targetPublicId: actor().publicId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      f.service.updateDeletion({
        ...mutation(),
        actor: { ...actor(), role: AdminRole.ADMIN },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.accounts.findOne).not.toHaveBeenCalled();
  });

  it('soft-deletes with CAS, authz invalidation, revoke-all and audit', async () => {
    const f = fixture();
    const result = await f.service.updateDeletion(mutation());
    expect(f.accounts.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 5,
        status: AdminAccountStatus.ACTIVE,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AdminAccountStatus.SOFT_DELETED,
          deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
        }),
        $inc: { authzVersion: 1, version: 1 },
      }),
      expect.objectContaining({ runValidators: true }),
    );
    expect(f.sessionService.revokeAllInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: AdminSessionRevokeReason.ACCOUNT_DELETED,
      }),
    );
    expect(result).toMatchObject({
      admin: {
        status: AdminAccountStatus.SOFT_DELETED,
        deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
        version: 6,
      },
      revokedSessionCount: 2,
    });
  });

  it('restores only an ADMIN deletion to LOCKED without reviving sessions', async () => {
    const stored = target(AdminRole.ADMIN, AdminAccountStatus.SOFT_DELETED);
    const updated = {
      ...stored,
      status: AdminAccountStatus.LOCKED,
      version: 6,
      authzVersion: 4,
      deletedAt: null,
      deletionOrigin: null,
      lockedAt: now,
    };
    const f = fixture(stored, updated);
    const result = await f.service.updateDeletion(
      mutation({
        actor: actor(AdminPermission.ADMINS_RESTORE),
        action: AdminAccountDeletionAction.RESTORE,
        correlationId: 'admin-restore-20260813-0001',
      }),
    );
    expect(f.sessionService.revokeAllInTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      admin: {
        status: AdminAccountStatus.LOCKED,
        deletionOrigin: null,
        deletedAt: null,
      },
      revokedSessionCount: 0,
    });
  });

  it('requires purpose-bound re-auth for a SuperAdmin target', async () => {
    const f = fixture(target(AdminRole.SUPER_ADMIN));
    await expect(f.service.updateDeletion(mutation())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('binds restore re-auth to its target and distinct purpose', async () => {
    const f = fixture(
      target(AdminRole.SUPER_ADMIN, AdminAccountStatus.SOFT_DELETED),
    );
    await f.service.issueSuperAdminDeletionReauth({
      actor: actor(AdminPermission.ADMINS_RESTORE),
      targetPublicId: 'adm_3456789ABCDE',
      action: AdminAccountDeletionAction.RESTORE,
      password: 'Password!1',
      totpToken: '123456',
      trustedClientIp: '127.0.0.1',
    });
    expect(f.reauth.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: AdminReauthPurpose.SUPER_ADMIN_RESTORE,
        targetPublicId: 'adm_3456789ABCDE',
      }),
    );
  });

  it('preserves the final effective SuperAdmin', async () => {
    const f = fixture(target(AdminRole.SUPER_ADMIN), undefined, false);
    await expect(
      f.service.updateDeletion(mutation({ reauthGrant: 'G'.repeat(43) })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.reauth.consumeInTransaction).not.toHaveBeenCalled();
    expect(f.accounts.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('allows deleting a locked SuperAdmin when another effective one remains', async () => {
    const stored = target(AdminRole.SUPER_ADMIN, AdminAccountStatus.LOCKED);
    const updated = {
      ...stored,
      status: AdminAccountStatus.SOFT_DELETED,
      version: 6,
      authzVersion: 4,
      lockedAt: null,
      deletedAt: now,
      deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
    };
    const f = fixture(stored, updated, true);

    await expect(
      f.service.updateDeletion(mutation({ reauthGrant: 'G'.repeat(43) })),
    ).resolves.toMatchObject({
      admin: { status: AdminAccountStatus.SOFT_DELETED },
    });
    expect(
      f.lastSuperAdmin.assertCanRemoveEffectiveAccess,
    ).toHaveBeenCalledWith(targetId, expect.anything());
  });
});
