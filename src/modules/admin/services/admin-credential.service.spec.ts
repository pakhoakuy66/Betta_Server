import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import {
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditSource,
} from '../constants/admin-audit.constants';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminCredentialService } from './admin-credential.service';

jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));
const compareMock = bcrypt.compare as unknown as jest.MockedFunction<
  (plain: string, hash: string) => Promise<boolean>
>;
const hashMock = bcrypt.hash as unknown as jest.MockedFunction<
  (plain: string, rounds: number) => Promise<string>
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

describe('AdminCredentialService', () => {
  const mongoSession = { inTransaction: () => true };
  const account = {
    _id: new Types.ObjectId(),
    publicId: 'adm_23456789ABCD',
    passwordHash: '$2b$12$current',
    credentialVersion: 2,
    version: 5,
    recoveryCodeHashes: ['recovery-hash'],
  };
  const actor = {
    type: AdminAuditActorType.ADMIN_ACCOUNT,
    publicId: account.publicId,
    username: 'admin.one',
    displayName: 'Admin One',
    role: AdminRole.ADMIN,
    permissionVersion: 1,
  } as const;

  let accounts: { findOne: jest.Mock; updateOne: jest.Mock };
  let grants: { updateMany: jest.Mock; create: jest.Mock };
  let mfa: { verifyTotpInTransaction: jest.Mock };
  let sessions: { revokeAllInTransaction: jest.Mock };
  let audit: { record: jest.Mock };
  let protection: {
    assertAllowed: jest.Mock;
    recordFailure: jest.Mock;
    clearAccountFailuresInTransaction: jest.Mock;
  };
  let crypto: {
    hashRecoveryCode: jest.Mock;
    generateTotpSecret: jest.Mock;
    encryptTotpSecret: jest.Mock;
  };
  let service: AdminCredentialService;

  beforeEach(() => {
    jest.clearAllMocks();
    accounts = {
      findOne: jest.fn().mockReturnValue(query(account)),
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
    mfa = {
      verifyTotpInTransaction: jest
        .fn<(...args: unknown[]) => Promise<boolean>>()
        .mockResolvedValue(true),
    };
    sessions = {
      revokeAllInTransaction: jest
        .fn<(...args: unknown[]) => Promise<number>>()
        .mockResolvedValue(2),
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
    crypto = {
      hashRecoveryCode: jest.fn().mockReturnValue('recovery-hash'),
      generateTotpSecret: jest.fn().mockReturnValue(Buffer.alloc(20, 7)),
      encryptTotpSecret: jest.fn().mockReturnValue('enc:v1:pending'),
    };
    const connection = {
      transaction: jest.fn((operation: (session: unknown) => unknown) =>
        Promise.resolve(operation(mongoSession)),
      ),
    };
    service = new AdminCredentialService(
      accounts as never,
      grants as never,
      connection as never,
      {
        environment: 'test',
        mfa: {
          algorithm: 'SHA1',
          digits: 6,
          periodSeconds: 30,
        },
      } as never,
      mfa as never,
      crypto as never,
      sessions as never,
      audit as never,
      protection as never,
    );
  });

  it('changes password only after current password and TOTP, then revokes all sessions', async () => {
    compareMock.mockResolvedValue(true);
    hashMock.mockResolvedValue('$2b$12$next');
    await service.changePassword({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      currentPassword: 'Current#123',
      newPassword: 'Next#Password9',
      totpToken: '123456',
      trustedClientIp: '203.0.113.10',
      actor,
      source: AdminAuditSource.HTTP,
    });
    expect(accounts.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: account.passwordHash }),
      expect.objectContaining({
        $set: { passwordHash: '$2b$12$next' },
        $inc: { credentialVersion: 1, version: 1 },
      }),
      expect.objectContaining({ session: mongoSession }),
    );
    expect(sessions.revokeAllInTransaction).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AdminAuditAction.PASSWORD_CHANGED }),
    );
    expect(protection.assertAllowed).toHaveBeenCalledWith({
      accountKey: account.publicId,
      trustedClientIp: '203.0.113.10',
    });
    expect(protection.clearAccountFailuresInTransaction).toHaveBeenCalledWith(
      account.publicId,
      mongoSession,
    );
  });

  it('records exactly one failed current-password proof', async () => {
    compareMock.mockResolvedValue(false);
    await expect(
      service.changePassword({
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        currentPassword: 'Wrong#Password9',
        newPassword: 'Next#Password9',
        totpToken: '123456',
        trustedClientIp: '203.0.113.10',
        actor,
        source: AdminAuditSource.HTTP,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(protection.recordFailure).toHaveBeenCalledTimes(1);
    expect(accounts.updateOne).not.toHaveBeenCalled();
  });

  it('records exactly one failed TOTP proof outside the rolled-back transaction', async () => {
    compareMock.mockResolvedValue(true);
    hashMock.mockResolvedValue('$2b$12$next');
    (
      mfa.verifyTotpInTransaction as jest.MockedFunction<
        (...args: unknown[]) => Promise<boolean>
      >
    ).mockResolvedValue(false);
    await expect(
      service.changePassword({
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        currentPassword: 'Current#123',
        newPassword: 'Next#Password9',
        totpToken: '000000',
        trustedClientIp: '203.0.113.10',
        actor,
        source: AdminAuditSource.HTTP,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(protection.recordFailure).toHaveBeenCalledTimes(1);
    expect(accounts.updateOne).not.toHaveBeenCalled();
  });

  it('rejects a new password above the bcrypt 72-byte UTF-8 boundary', async () => {
    await expect(
      service.changePassword({
        adminAccountId: account._id,
        adminPublicId: account.publicId,
        currentPassword: 'Current#123',
        newPassword: `A1#${'😀'.repeat(18)}`,
        totpToken: '123456',
        trustedClientIp: '203.0.113.10',
        actor,
        source: AdminAuditSource.HTTP,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(protection.assertAllowed).not.toHaveBeenCalled();
    expect(hashMock).not.toHaveBeenCalled();
  });

  it('consumes one recovery code into a finite enrollment and returns no stored secret', async () => {
    compareMock.mockResolvedValue(true);
    const result = await service.beginRecoveryCodeEnrollment({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      password: 'Current#123',
      recoveryCode: 'RECOVERY-CODE',
      accountLabel: 'admin.one',
      trustedClientIp: '203.0.113.10',
      source: AdminAuditSource.HTTP,
    });
    expect(result.secretBase32).toMatch(/^[A-Z2-7]+$/);
    expect(result.confirmationGrant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grants.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          grantHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          secretReference: 'inline:recovery-code',
        }),
      ],
      { session: mongoSession },
    );
    expect(JSON.stringify(grants.create.mock.calls)).not.toContain(
      result.confirmationGrant,
    );
    expect(sessions.revokeAllInTransaction).toHaveBeenCalled();
  });
});
