import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminAuditActorType } from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { type AdminLifecycleActor } from '../interfaces/admin-account-lifecycle.interface';
import { type PutAdminBootstrapSecretInput } from '../interfaces/admin-bootstrap.interface';
import { AdminAccountLifecycleService } from './admin-account-lifecycle.service';

const actor = (): AdminLifecycleActor => ({
  type: AdminAuditActorType.ADMIN_ACCOUNT,
  adminAccountId: new Types.ObjectId(),
  publicId: 'adm_23456789ABCD',
  username: 'root.admin',
  displayName: 'Root Admin',
  role: AdminRole.SUPER_ADMIN,
  permission: AdminPermission.ADMINS_CREATE,
  permissionVersion: 1,
  sessionPublicId: 'ases_23456789ABCDEFGHJKLMNPQR',
  credentialVersion: 1,
  authzVersion: 1,
});

const createFixture = () => {
  const mongoSession = { inTransaction: () => true };
  const accounts = {
    create: jest.fn<(documents: unknown[]) => Promise<unknown[]>>(),
    findOne: jest.fn(),
  };
  const creationRequests = {
    create: jest.fn<(documents: unknown[]) => Promise<unknown[]>>(() =>
      Promise.resolve([]),
    ),
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => ({ exec: () => Promise.resolve(null) }),
      }),
    })),
  };
  const connection = {
    transaction: jest.fn((operation: (session: unknown) => unknown) =>
      Promise.resolve(operation(mongoSession)),
    ),
  };
  const secretStore = {
    assertReady: jest.fn(),
    putVersion: jest.fn<
      (input: PutAdminBootstrapSecretInput) => Promise<string>
    >(() => Promise.resolve('sm://betta/admin-activation/versions/1')),
    revokeVersion: jest.fn<(reference: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };
  const reauth = {
    issue: jest.fn<(input: unknown) => Promise<unknown>>(),
    consumeInTransaction: jest.fn<(input: unknown) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };
  const audit = {
    record: jest.fn<(input: unknown) => Promise<string>>(() =>
      Promise.resolve('aaud_23456789ABCDEFGH'),
    ),
  };
  const service = new AdminAccountLifecycleService(
    accounts as never,
    creationRequests as never,
    connection as never,
    {
      environment: 'test',
      activation: { grantTtlSeconds: 900 },
    } as never,
    secretStore,
    reauth as never,
    audit as never,
  );

  return {
    service,
    accounts,
    creationRequests,
    connection,
    secretStore,
    reauth,
    audit,
  };
};

const request = () => ({
  actor: actor(),
  email: ' NEW.ADMIN@BETTA.TEST ',
  username: ' New.Admin ',
  displayName: ' New Admin ',
  reauthGrant: 'A'.repeat(43),
  reasonCode: 'team_capacity',
  correlationId: 'admin-create-20260812-0001',
  idempotencyKey: 'admin-create-request-0001',
});

describe('AdminAccountLifecycleService', () => {
  it('rejects a non-SuperAdmin before secret or database access', async () => {
    const fixture = createFixture();
    const input = request();

    await expect(
      fixture.service.createAdmin({
        ...input,
        actor: { ...input.actor, role: AdminRole.ADMIN },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fixture.secretStore.assertReady).not.toHaveBeenCalled();
    expect(fixture.connection.transaction).not.toHaveBeenCalled();
  });

  it('creates only a pending ADMIN and never returns or persists the raw grant', async () => {
    const fixture = createFixture();
    fixture.accounts.create.mockImplementationOnce((documents) => {
      const source = (documents as Array<Record<string, unknown>>)[0];
      return Promise.resolve([
        {
          ...source,
          createdAt: new Date('2026-08-12T00:00:00.000Z'),
          updatedAt: new Date('2026-08-12T00:00:00.000Z'),
        },
      ]);
    });

    const result = await fixture.service.createAdmin(request());
    const persisted = (
      fixture.accounts.create.mock.calls[0][0] as Array<Record<string, unknown>>
    )[0];
    const secretInput = fixture.secretStore.putVersion.mock.calls[0]?.[0];
    if (!secretInput) throw new Error('Secret write was not called');

    expect(persisted).toMatchObject({
      email: 'new.admin@betta.test',
      username: 'new.admin',
      displayName: 'New Admin',
      role: AdminRole.ADMIN,
      mustChangePassword: true,
    });
    expect(persisted).not.toHaveProperty('password');
    expect(persisted).not.toHaveProperty('permissions');
    expect(secretInput.rawGrant).toHaveLength(43);
    expect(JSON.stringify(result)).not.toContain(secretInput.rawGrant);
    expect(result.activation.secretReference).toBe(
      'sm://betta/admin-activation/versions/1',
    );
    expect(fixture.reauth.consumeInTransaction).toHaveBeenCalledTimes(1);
    expect(fixture.creationRequests.create).toHaveBeenCalledTimes(1);
    const creationRequest = (
      fixture.creationRequests.create.mock.calls[0][0] as Array<
        Record<string, unknown>
      >
    )[0];
    expect(creationRequest.idempotencyExpiresAt).toBeInstanceOf(Date);
    expect(
      (creationRequest.idempotencyExpiresAt as Date).getTime() -
        (creationRequest.activationExpiresAt as Date).getTime(),
    ).toBeGreaterThan(23 * 60 * 60 * 1_000);
    expect(fixture.audit.record).toHaveBeenCalledTimes(1);
  });

  it('revokes the external secret and maps a duplicate identity to conflict', async () => {
    const fixture = createFixture();
    fixture.accounts.create.mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), { code: 11000 }),
    );

    await expect(fixture.service.createAdmin(request())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(fixture.secretStore.revokeVersion).toHaveBeenCalledWith(
      'sm://betta/admin-activation/versions/1',
    );
  });

  it('issues a purpose-bound re-auth grant for Admin creation', async () => {
    const fixture = createFixture();
    fixture.reauth.issue.mockResolvedValueOnce({
      grant: 'R'.repeat(43),
      expiresAt: new Date('2026-08-12T00:05:00.000Z'),
    });

    await fixture.service.issueCreateReauth({
      actor: actor(),
      password: 'Password!1',
      totpToken: '123456',
      trustedClientIp: '127.0.0.1',
    });

    expect(fixture.reauth.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'admins.create',
        targetPublicId: 'security_admin_create',
      }),
    );
  });
});
