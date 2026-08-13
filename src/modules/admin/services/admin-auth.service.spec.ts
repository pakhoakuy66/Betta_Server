import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_INVALID_CREDENTIALS_MESSAGE,
  ADMIN_LOGIN_SECURITY_CONTROL_PUBLIC_ID,
} from '../constants/admin-auth.constants';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { AdminAuthService } from './admin-auth.service';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));

const compareMock = bcrypt.compare as unknown as jest.MockedFunction<
  (plain: string, hash: string) => Promise<boolean>
>;

type AsyncMock<T> = jest.MockedFunction<(...args: unknown[]) => Promise<T>>;
type TransactionOperation = (session: unknown) => unknown;
type TransactionMock = jest.Mock<
  (operation: TransactionOperation) => Promise<unknown>
>;

const query = <T>(value: T) => {
  const chain = {
    select: jest.fn(),
    session: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn<() => Promise<T>>().mockResolvedValue(value),
  };
  chain.select.mockReturnValue(chain);
  chain.session.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
};

describe('AdminAuthService', () => {
  const mongoSession = { inTransaction: () => true };
  const account = {
    _id: new Types.ObjectId(),
    publicId: 'adm_23456789ABCD',
    username: 'root.admin',
    displayName: 'Root Admin',
    role: AdminRole.SUPER_ADMIN,
    status: AdminAccountStatus.ACTIVE,
    mfaStatus: AdminMfaStatus.ACTIVE,
    mustChangePassword: false,
    lockedAt: null,
    deletedAt: null,
    passwordHash: '$2b$12$valid',
    credentialVersion: 2,
    authzVersion: 3,
    permissionVersion: 4,
  } as const;
  const loginInput = {
    email: ' ROOT@BETTA.TEST ',
    password: 'correct password',
    totpToken: '123456',
    trustedClientIp: '203.0.113.10',
    userAgent: 'Chrome on Windows',
  } as const;

  let accountModel: { findOne: jest.Mock };
  let connection: { transaction: TransactionMock };
  let protection: {
    assertAllowed: AsyncMock<void>;
    recordFailure: AsyncMock<void>;
    clearAccountFailuresInTransaction: AsyncMock<void>;
  };
  let mfa: { verifyTotpInTransaction: AsyncMock<boolean> };
  let sessions: {
    createSession: AsyncMock<unknown>;
    rotateRefreshToken: AsyncMock<unknown>;
    revokeCurrentSession: AsyncMock<boolean>;
  };
  let accessTokens: { issue: AsyncMock<string> };
  let audit: { record: AsyncMock<string> };
  let service: AdminAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    accountModel = { findOne: jest.fn() };
    connection = {
      transaction: jest.fn(
        (operation: TransactionOperation): Promise<unknown> =>
          Promise.resolve(operation(mongoSession)),
      ),
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
    sessions = {
      createSession: jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({
          refreshToken: 'refresh-token',
          sessionPublicId: 'ases_12345678',
          expiresAt: new Date('2026-08-17T00:00:00.000Z'),
        }),
      rotateRefreshToken: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
      revokeCurrentSession: jest.fn<(...args: unknown[]) => Promise<boolean>>(),
    };
    accessTokens = {
      issue: jest
        .fn<(...args: unknown[]) => Promise<string>>()
        .mockResolvedValue('access-token'),
    };
    audit = {
      record: jest
        .fn<(...args: unknown[]) => Promise<string>>()
        .mockResolvedValue('aaud_test'),
    };
    service = new AdminAuthService(
      accountModel as never,
      connection as never,
      protection as never,
      mfa as never,
      sessions as never,
      accessTokens as never,
      audit as never,
    );
  });

  it('creates an atomic session only after password, eligibility and TOTP', async () => {
    accountModel.findOne
      .mockReturnValueOnce(query(account))
      .mockReturnValueOnce(query(account));
    compareMock.mockResolvedValue(true);

    const result = await service.login(loginInput);

    expect(protection.assertAllowed).toHaveBeenCalledWith({
      accountKey: 'root@betta.test',
      trustedClientIp: loginInput.trustedClientIp,
    });
    expect(mfa.verifyTotpInTransaction).toHaveBeenCalledWith(
      account._id,
      account.publicId,
      loginInput.totpToken,
      mongoSession,
    );
    expect(protection.clearAccountFailuresInTransaction).toHaveBeenCalledWith(
      'root@betta.test',
      mongoSession,
    );
    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: account.publicId }),
      { userAgent: loginInput.userAgent },
      mongoSession,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.LOGIN_SUCCEEDED,
        mongoSession,
      }),
    );
    expect(result).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      sessionPublicId: 'ases_12345678',
      admin: {
        id: account.publicId,
        publicId: account.publicId,
        role: AdminRole.SUPER_ADMIN,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /password|totp|recovery|credentialVersion|authzVersion|permissionVersion/i,
    );
  });

  it('runs the dummy bcrypt boundary and does not audit raw unknown identity', async () => {
    accountModel.findOne.mockReturnValue(query(null));
    compareMock.mockResolvedValue(false);

    await expect(service.login(loginInput)).rejects.toMatchObject({
      status: 401,
      message: ADMIN_INVALID_CREDENTIALS_MESSAGE,
    });

    expect(compareMock).toHaveBeenCalledTimes(1);
    expect(protection.recordFailure).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.SECURITY_REQUEST_DENIED,
        target: {
          type: AdminAuditTargetType.SECURITY_CONTROL,
          publicId: ADMIN_LOGIN_SECURITY_CONTROL_PUBLIC_ID,
        },
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      'root@betta.test',
    );
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it('returns the same generic denial for an ineligible known account', async () => {
    accountModel.findOne.mockReturnValue(
      query({ ...account, status: AdminAccountStatus.LOCKED }),
    );
    compareMock.mockResolvedValue(true);

    await expect(service.login(loginInput)).rejects.toMatchObject({
      status: 401,
      message: ADMIN_INVALID_CREDENTIALS_MESSAGE,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AdminAuditAction.LOGIN_DENIED }),
    );
  });

  it('rolls back the login path and records a failure when TOTP is invalid', async () => {
    accountModel.findOne
      .mockReturnValueOnce(query(account))
      .mockReturnValueOnce(query(account));
    compareMock.mockResolvedValue(true);
    mfa.verifyTotpInTransaction.mockResolvedValue(false);

    await expect(service.login(loginInput)).rejects.toMatchObject({
      status: 401,
      message: ADMIN_INVALID_CREDENTIALS_MESSAGE,
    });
    expect(protection.recordFailure).toHaveBeenCalledTimes(1);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it('preserves a rate-limit response after recording a denied audit', async () => {
    const limited = new HttpException('limited', HttpStatus.TOO_MANY_REQUESTS);
    accountModel.findOne.mockReturnValue(query(null));
    compareMock.mockResolvedValue(false);
    protection.recordFailure.mockRejectedValue(limited);

    await expect(service.login(loginInput)).rejects.toBe(limited);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rotates refresh credentials and issues an access token from returned versions', async () => {
    sessions.rotateRefreshToken.mockResolvedValue({
      refreshToken: 'refresh-2',
      sessionPublicId: 'ases_12345678',
      expiresAt: new Date('2026-08-17T00:00:00.000Z'),
      account,
    });

    const result = await service.refresh('refresh-1');

    expect(accessTokens.issue).toHaveBeenCalledWith({
      adminPublicId: account.publicId,
      sessionPublicId: 'ases_12345678',
      credentialVersion: account.credentialVersion,
      authzVersion: account.authzVersion,
      permissionVersion: account.permissionVersion,
    });
    expect(result.refreshToken).toBe('refresh-2');
  });

  it('delegates idempotent current-session logout', async () => {
    sessions.revokeCurrentSession.mockResolvedValue(false);
    await expect(service.logout(account, 'ases_12345678')).resolves.toBe(false);
    expect(sessions.revokeCurrentSession).toHaveBeenCalledWith(
      account,
      'ases_12345678',
    );
  });

  it('rejects malformed inputs before database or bcrypt work', async () => {
    await expect(
      service.login({ ...loginInput, totpToken: '12345x' }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(service.refresh('')).rejects.toMatchObject({ status: 401 });
    expect(accountModel.findOne).not.toHaveBeenCalled();
    expect(compareMock).not.toHaveBeenCalled();
  });
});
