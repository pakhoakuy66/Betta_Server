import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import {
  AdminAccountStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { AdminAuditActorType } from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import { AdminSessionRevokeReason } from '../constants/admin-session.constants';
import { type AdminAccountStatusActor } from '../interfaces/admin-account-status.interface';
import { AdminAccountStatusService } from './admin-account-status.service';

const targetId = new Types.ObjectId();
const now = new Date('2026-08-13T00:00:00.000Z');

const actor = (
  permission: AdminPermission = AdminPermission.ADMINS_LOCK,
): AdminAccountStatusActor => ({
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
  deletedAt: null,
  updatedAt: now,
});

const documentQuery = (value: unknown) => {
  const query = {
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(value)),
  };
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
};

const sessionQuery = (value: unknown) => ({
  session: jest.fn(() => Promise.resolve(value)),
});

const createFixture = (
  storedTarget = target(),
  updatedTarget: ReturnType<typeof target> = {
    ...target(),
    status: AdminAccountStatus.LOCKED,
    version: 6,
    authzVersion: 4,
    lockedAt: now,
  },
  anotherEffectiveSuperAdmin = true,
) => {
  const mongoSession = { inTransaction: () => true };
  const accounts = {
    findOne: jest.fn(() => documentQuery(storedTarget)),
    findOneAndUpdate: jest.fn<
      (
        filter: unknown,
        update: unknown,
        options: unknown,
      ) => ReturnType<typeof documentQuery>
    >(() => documentQuery(updatedTarget)),
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
    consumeInTransaction: jest.fn<(input: unknown) => Promise<void>>(() =>
      Promise.resolve(),
    ),
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
  const audit = {
    record: jest.fn<(input: unknown) => Promise<string>>(() =>
      Promise.resolve('aaud_23456789ABCDEFGH'),
    ),
  };
  const service = new AdminAccountStatusService(
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
    sessions,
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
  status: AdminAccountStatus.LOCKED,
  expectedVersion: 5,
  reasonCode: 'security_review',
  reasonNote: 'Approved security response',
  correlationId: 'admin-lock-20260813-0001',
  ...overrides,
});

describe('AdminAccountStatusService', () => {
  it('rejects self-action and non-SuperAdmin actors before database access', async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.updateStatus({
        ...mutation(),
        targetPublicId: actor().publicId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      fixture.service.updateStatus({
        ...mutation(),
        actor: { ...actor(), role: AdminRole.ADMIN },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fixture.accounts.findOne).not.toHaveBeenCalled();
  });

  it('locks an Admin with CAS, revokes sessions and audits the finite diff', async () => {
    const fixture = createFixture();
    const result = await fixture.service.updateStatus(mutation());

    expect(fixture.accounts.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: targetId,
        status: AdminAccountStatus.ACTIVE,
        version: 5,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: AdminAccountStatus.LOCKED }),
        $inc: { authzVersion: 1, version: 1 },
      }),
      expect.objectContaining({ runValidators: true }),
    );
    expect(fixture.sessionService.revokeAllInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAdminAccountId: targetId,
        reason: AdminSessionRevokeReason.ACCOUNT_LOCKED,
      }),
    );
    expect(fixture.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          beforeVersion: 5,
          afterVersion: 6,
          beforeState: AdminAccountStatus.ACTIVE,
          afterState: AdminAccountStatus.LOCKED,
          affectedSessionCount: 2,
        },
      }),
    );
    expect(fixture.reauth.consumeInTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      admin: { status: AdminAccountStatus.LOCKED, version: 6 },
      revokedSessionCount: 2,
    });
  });

  it('unlocks without restoring any old session', async () => {
    const stored = target(AdminRole.ADMIN, AdminAccountStatus.LOCKED);
    const updated = {
      ...stored,
      status: AdminAccountStatus.ACTIVE,
      version: 6,
      authzVersion: 4,
      lockedAt: null,
    };
    const fixture = createFixture(stored, updated);

    const result = await fixture.service.updateStatus(
      mutation({
        actor: actor(AdminPermission.ADMINS_UNLOCK),
        status: AdminAccountStatus.ACTIVE,
        correlationId: 'admin-unlock-20260813-0001',
      }),
    );

    expect(
      fixture.sessionService.revokeAllInTransaction,
    ).not.toHaveBeenCalled();
    expect(result.revokedSessionCount).toBe(0);
    expect(result.admin).toMatchObject({
      status: AdminAccountStatus.ACTIVE,
      lockedAt: null,
      version: 6,
    });
  });

  it('requires a purpose-bound re-auth grant for any SuperAdmin target', async () => {
    const fixture = createFixture(target(AdminRole.SUPER_ADMIN));

    await expect(
      fixture.service.updateStatus(mutation()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(fixture.connection.transaction).not.toHaveBeenCalled();
  });

  it('binds an unlock re-auth grant to target and unlock purpose', async () => {
    const fixture = createFixture(
      target(AdminRole.SUPER_ADMIN, AdminAccountStatus.LOCKED),
    );

    await fixture.service.issueSuperAdminStatusReauth({
      actor: actor(AdminPermission.ADMINS_UNLOCK),
      targetPublicId: 'adm_3456789ABCDE',
      status: AdminAccountStatus.ACTIVE,
      password: 'Password!1',
      totpToken: '123456',
      trustedClientIp: '127.0.0.1',
    });

    expect(fixture.reauth.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: AdminReauthPurpose.SUPER_ADMIN_UNLOCK,
        targetPublicId: 'adm_3456789ABCDE',
      }),
    );
  });

  it('keeps the final effective SuperAdmin active', async () => {
    const fixture = createFixture(
      target(AdminRole.SUPER_ADMIN),
      undefined,
      false,
    );

    await expect(
      fixture.service.updateStatus(mutation({ reauthGrant: 'G'.repeat(43) })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.lastSuperAdmin.prepareCoordinator).toHaveBeenCalledTimes(1);
    expect(
      fixture.lastSuperAdmin.assertCanRemoveEffectiveAccess,
    ).toHaveBeenCalledWith(targetId, expect.anything());
    expect(fixture.reauth.consumeInTransaction).not.toHaveBeenCalled();
    expect(fixture.accounts.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
