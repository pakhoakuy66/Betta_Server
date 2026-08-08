import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { type Mock } from 'jest-mock';
import { type Model, Types } from 'mongoose';
import { type AdminPolicy } from '../config/admin-policy.config';
import { type AdminSecrets } from '../config/admin-secrets.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_ACCESS_TOKEN_AUDIENCE,
  ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  ADMIN_ACCESS_TOKEN_ISSUER,
  ADMIN_ACCESS_TOKEN_USE,
} from '../constants/admin-auth-token.constants';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminJwtStrategy } from './admin-jwt.strategy';

type QueryMock<T> = {
  select: Mock<(projection: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

const ADMIN_OBJECT_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');
const ADMIN_ID = 'adm_23456789ABCD';
const SESSION_ID = `ases_${'a'.repeat(36)}`;

const createQuery = <T>(value: T): QueryMock<T> => {
  const query = {} as QueryMock<T>;
  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() => Promise.resolve(value));
  return query;
};

const adminSecrets = {
  resolve: jest.fn(),
} as unknown as AdminSecrets;

const adminPolicy = {
  session: { accessTokenTtlSeconds: 900 },
} as AdminPolicy;

const validPayload = {
  tokenUse: ADMIN_ACCESS_TOKEN_USE,
  sub: ADMIN_ID,
  sid: SESSION_ID,
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
  iss: ADMIN_ACCESS_TOKEN_ISSUER,
  aud: ADMIN_ACCESS_TOKEN_AUDIENCE,
  iat: 1_000,
  exp: 1_900,
};

const activeAccount = {
  _id: ADMIN_OBJECT_ID,
  publicId: ADMIN_ID,
  username: 'admin.qa',
  displayName: 'Admin QA',
  role: AdminRole.ADMIN,
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
};

const createContext = () => {
  const adminAccountModel = { findOne: jest.fn() };
  const strategy = new AdminJwtStrategy(
    adminSecrets,
    adminPolicy,
    adminAccountModel as unknown as Model<AdminAccount>,
  );

  return { strategy, adminAccountModel };
};

describe('AdminJwtStrategy', () => {
  it.each([
    [{ ...validPayload, tokenUse: 'access' }],
    [{ ...validPayload, sub: 'usr_23456789ABCD' }],
    [{ ...validPayload, sid: `ses_${'a'.repeat(36)}` }],
    [{ ...validPayload, permissionVersion: -1 }],
    [{ ...validPayload, exp: 1_901 }],
    [{ ...validPayload, role: AdminRole.SUPER_ADMIN }],
    [{ ...validPayload, permissions: ['admins.create'] }],
    [{ ...validPayload, _id: ADMIN_OBJECT_ID.toHexString() }],
  ])(
    'rejects an invalid or expanded claim contract before MongoDB',
    async (payload) => {
      const { strategy, adminAccountModel } = createContext();

      await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(adminAccountModel.findOne).not.toHaveBeenCalled();
    },
  );

  it('accepts iat at the configured future clock-skew boundary', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const iat = nowSeconds + ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS;
    const { strategy, adminAccountModel } = createContext();
    adminAccountModel.findOne.mockReturnValue(createQuery(activeAccount));

    await expect(
      strategy.validate({ ...validPayload, iat, exp: iat + 900 }),
    ).resolves.toMatchObject({ publicId: ADMIN_ID });
  });

  it.each([
    [
      'iat beyond clock skew',
      () => {
        const iat =
          Math.floor(Date.now() / 1000) +
          ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS +
          1;
        return { ...validPayload, iat, exp: iat + 900 };
      },
    ],
    ['exp equal to iat', () => ({ ...validPayload, exp: validPayload.iat })],
    [
      'lifetime above policy by one second',
      () => ({ ...validPayload, exp: validPayload.iat + 901 }),
    ],
    [
      'unsafe integer time claim',
      () => ({ ...validPayload, exp: Number.MAX_SAFE_INTEGER + 1 }),
    ],
  ])('rejects %s before MongoDB', async (_label, createPayload) => {
    const { strategy, adminAccountModel } = createContext();

    await expect(strategy.validate(createPayload())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(adminAccountModel.findOne).not.toHaveBeenCalled();
  });

  it('hydrates an immutable principal from the authoritative account', async () => {
    const { strategy, adminAccountModel } = createContext();
    const query = createQuery(activeAccount);
    adminAccountModel.findOne.mockReturnValue(query);

    const principal = await strategy.validate(validPayload);

    expect(principal).toStrictEqual({
      adminAccountId: ADMIN_OBJECT_ID.toHexString(),
      id: ADMIN_ID,
      publicId: ADMIN_ID,
      username: 'admin.qa',
      displayName: 'Admin QA',
      role: AdminRole.ADMIN,
      sessionId: SESSION_ID,
      credentialVersion: 2,
      authzVersion: 3,
      permissionVersion: 4,
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(adminAccountModel.findOne).toHaveBeenCalledWith({
      publicId: ADMIN_ID,
      status: AdminAccountStatus.ACTIVE,
      deletedAt: null,
      mustChangePassword: false,
      mfaStatus: AdminMfaStatus.ACTIVE,
    });
    expect(query.select).toHaveBeenCalledWith(
      '_id publicId username displayName role ' +
        '+credentialVersion +authzVersion +permissionVersion',
    );
  });

  it.each([
    ['missing account', null],
    ['stale credential version', { ...activeAccount, credentialVersion: 1 }],
    ['stale authorization version', { ...activeAccount, authzVersion: 2 }],
    ['stale permission version', { ...activeAccount, permissionVersion: 3 }],
    ['unknown role', { ...activeAccount, role: 'ROOT' }],
  ])('returns the same 401 for %s', async (_label, account) => {
    const { strategy, adminAccountModel } = createContext();
    adminAccountModel.findOne.mockReturnValue(createQuery(account));

    let thrown: unknown;
    try {
      await strategy.validate(validPayload);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect((thrown as UnauthorizedException).message).toBe(
      'Phiên quản trị không hợp lệ hoặc đã hết hạn',
    );
    expect((thrown as UnauthorizedException).message).not.toContain(ADMIN_ID);
    expect((thrown as UnauthorizedException).message).not.toContain(
      ADMIN_OBJECT_ID.toHexString(),
    );
  });

  it('maps MongoDB infrastructure failure to 503', async () => {
    const { strategy, adminAccountModel } = createContext();
    const query = createQuery<typeof activeAccount | null>(null);
    query.exec.mockRejectedValue({ name: 'MongoServerSelectionError' });
    adminAccountModel.findOne.mockReturnValue(query);

    await expect(strategy.validate(validPayload)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not disguise programming errors as authentication failures', async () => {
    const error = new TypeError('projection contract broken');
    const { strategy, adminAccountModel } = createContext();
    const query = createQuery<typeof activeAccount | null>(null);
    query.exec.mockRejectedValue(error);
    adminAccountModel.findOne.mockReturnValue(query);

    await expect(strategy.validate(validPayload)).rejects.toBe(error);
  });
});
