import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditSource,
} from '../constants/admin-audit.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import { AdminReauthService } from './admin-reauth.service';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));
const compareMock = bcrypt.compare as unknown as jest.MockedFunction<
  (plain: string, hash: string) => Promise<boolean>
>;

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

describe('AdminReauthService', () => {
  const mongoSession = { inTransaction: () => true };
  const account = {
    _id: new Types.ObjectId(),
    publicId: 'adm_23456789ABCD',
    status: AdminAccountStatus.ACTIVE,
    mfaStatus: AdminMfaStatus.ACTIVE,
    passwordHash: '$2b$12$hash',
    credentialVersion: 2,
    authzVersion: 3,
    permissionVersion: 4,
  };
  const actor = {
    type: AdminAuditActorType.ADMIN_ACCOUNT,
    publicId: account.publicId,
    username: 'root.admin',
    displayName: 'Root Admin',
    role: AdminRole.SUPER_ADMIN,
    permissionVersion: 4,
  } as const;
  const input = {
    adminAccountId: account._id,
    adminPublicId: account.publicId,
    sessionPublicId: 'ases_23456789ABCDEFGH',
    password: 'Correct#123',
    totpToken: '123456',
    purpose: AdminReauthPurpose.ADMIN_MFA_RESET,
    targetPublicId: 'adm_ABCDEFGHJKLM',
    trustedClientIp: '203.0.113.10',
    actor,
    source: AdminAuditSource.HTTP,
  } as const;

  let accounts: { findOne: jest.Mock };
  let sessions: { exists: jest.Mock };
  let grants: {
    create: jest.Mock;
    findOneAndUpdate: jest.MockedFunction<
      (...args: unknown[]) => Promise<{ publicId: string } | null>
    >;
  };
  let audit: { record: jest.Mock };
  let protection: {
    assertAllowed: jest.Mock;
    recordFailure: jest.Mock;
    clearAccountFailuresInTransaction: jest.Mock;
  };
  let mfa: { verifyTotpInTransaction: jest.Mock };
  let service: AdminReauthService;

  beforeEach(() => {
    jest.clearAllMocks();
    accounts = { findOne: jest.fn().mockReturnValue(query(account)) };
    sessions = {
      exists: jest.fn().mockReturnValue({
        session: jest
          .fn<(...args: unknown[]) => Promise<{ _id: Types.ObjectId }>>()
          .mockResolvedValue({ _id: new Types.ObjectId() }),
      }),
    };
    grants = {
      create: jest
        .fn<(...args: unknown[]) => Promise<unknown[]>>()
        .mockResolvedValue([{ publicId: 'argt_23456789ABCDEFGHJKLMNPQR' }]),
      findOneAndUpdate:
        jest.fn<(...args: unknown[]) => Promise<{ publicId: string } | null>>(),
    };
    audit = {
      record: jest
        .fn<(...args: unknown[]) => Promise<string>>()
        .mockResolvedValue('aaud_test'),
    };
    protection = {
      assertAllowed: jest
        .fn<(...args: unknown[]) => Promise<void>>()
        .mockResolvedValue(),
      recordFailure: jest
        .fn<(...args: unknown[]) => Promise<void>>()
        .mockResolvedValue(),
      clearAccountFailuresInTransaction: jest
        .fn<(...args: unknown[]) => Promise<void>>()
        .mockResolvedValue(),
    };
    mfa = {
      verifyTotpInTransaction: jest
        .fn<(...args: unknown[]) => Promise<boolean>>()
        .mockResolvedValue(true),
    };
    const connection = {
      transaction: jest.fn((operation: (session: unknown) => unknown) =>
        Promise.resolve(operation(mongoSession)),
      ),
    };
    service = new AdminReauthService(
      accounts as never,
      sessions as never,
      grants as never,
      connection as never,
      { reauthentication: { grantTtlSeconds: 300 } } as never,
      mfa as never,
      audit as never,
      protection as never,
    );
  });

  it('issues an opaque hash-only grant after password, session and TOTP', async () => {
    compareMock.mockResolvedValue(true);
    const result = await service.issue(input);
    expect(result.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grants.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          grantHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          purpose: input.purpose,
          targetPublicId: input.targetPublicId,
        }),
      ],
      { session: mongoSession },
    );
    expect(JSON.stringify(grants.create.mock.calls)).not.toContain(
      result.grant,
    );
    expect(mfa.verifyTotpInTransaction).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AdminAuditAction.REAUTH_GRANT_ISSUED }),
    );
  });

  it('records a generic denial and creates no grant for a wrong password', async () => {
    compareMock.mockResolvedValue(false);
    await expect(service.issue(input)).rejects.toMatchObject({ status: 401 });
    expect(protection.recordFailure).toHaveBeenCalled();
    expect(grants.create).not.toHaveBeenCalled();
  });

  it('records exactly one denial when the shared session is inactive', async () => {
    compareMock.mockResolvedValue(true);
    sessions.exists.mockReturnValue({
      session: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    });
    await expect(service.issue(input)).rejects.toMatchObject({ status: 401 });
    expect(protection.recordFailure).toHaveBeenCalledTimes(1);
    expect(mfa.verifyTotpInTransaction).not.toHaveBeenCalled();
    expect(grants.create).not.toHaveBeenCalled();
  });

  it('records exactly one denial for a wrong TOTP after a valid password', async () => {
    compareMock.mockResolvedValue(true);
    (
      mfa.verifyTotpInTransaction as jest.MockedFunction<
        (...args: unknown[]) => Promise<boolean>
      >
    ).mockResolvedValue(false);
    await expect(service.issue(input)).rejects.toMatchObject({ status: 401 });
    expect(protection.recordFailure).toHaveBeenCalledTimes(1);
    expect(grants.create).not.toHaveBeenCalled();
  });

  it('consumes a version and purpose-bound grant only once', async () => {
    const grant = 'A'.repeat(43);
    grants.findOneAndUpdate
      .mockResolvedValueOnce({ publicId: 'argt_23456789ABCDEFGHJKLMNPQR' })
      .mockResolvedValueOnce(null);
    const consume = {
      rawGrant: grant,
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      sessionPublicId: input.sessionPublicId,
      credentialVersion: 2,
      authzVersion: 3,
      permissionVersion: 4,
      purpose: input.purpose,
      targetPublicId: input.targetPublicId,
      actor,
      source: AdminAuditSource.HTTP,
      mongoSession: mongoSession as never,
    } as const;
    await expect(
      service.consumeInTransaction(consume),
    ).resolves.toBeUndefined();
    await expect(service.consumeInTransaction(consume)).rejects.toMatchObject({
      status: 401,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('preserves transient MongoDB errors for the caller transaction to retry', async () => {
    const transient = Object.assign(new Error('forced write conflict'), {
      errorLabels: ['TransientTransactionError'],
    });
    grants.findOneAndUpdate.mockResolvedValue({
      publicId: 'argt_23456789ABCDEFGHJKLMNPQR',
    });
    (
      audit.record as jest.MockedFunction<
        (...args: unknown[]) => Promise<string>
      >
    ).mockRejectedValueOnce(transient);

    await expect(
      service.consumeInTransaction({
        rawGrant: 'A'.repeat(43),
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        sessionPublicId: input.sessionPublicId,
        credentialVersion: 2,
        authzVersion: 3,
        permissionVersion: 4,
        purpose: input.purpose,
        targetPublicId: input.targetPublicId,
        actor,
        source: AdminAuditSource.HTTP,
        mongoSession: mongoSession as never,
      }),
    ).rejects.toBe(transient);
  });
});
