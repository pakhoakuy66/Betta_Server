import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { type Mock } from 'jest-mock';
import { type Model, Types } from 'mongoose';
import { AdminRole } from '../constants/admin-account.constants';
import { ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS } from '../constants/admin-authorization-state.constants';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { AdminAuthorizationStateService } from './admin-authorization-state.service';

type QueryMock<T> = {
  select: Mock<(projection: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

const ADMIN_OBJECT_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');
const ADMIN_ID = 'adm_23456789ABCD';
const SESSION_ID = `ases_${'a'.repeat(36)}`;

const createQuery = <T>(factory: () => Promise<T>): QueryMock<T> => {
  const query = {} as QueryMock<T>;
  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(factory);
  return query;
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

const validInput = {
  adminPublicId: ADMIN_ID,
  sessionPublicId: SESSION_ID,
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
};

const createContext = () => {
  let nowMs = 10_000;
  let account: typeof activeAccount | null = activeAccount;
  let session: { _id: Types.ObjectId } | null = { _id: new Types.ObjectId() };
  let accountError: Error | undefined;
  let sessionError: Error | undefined;

  const accountModel = {
    findOne: jest.fn(() =>
      createQuery(() => {
        if (accountError) return Promise.reject(accountError);
        return Promise.resolve(account);
      }),
    ),
  };
  const sessionModel = {
    findOne: jest.fn(() =>
      createQuery(() => {
        if (sessionError) return Promise.reject(sessionError);
        return Promise.resolve(session);
      }),
    ),
  };
  const service = new AdminAuthorizationStateService(
    accountModel as unknown as Model<AdminAccount>,
    sessionModel as unknown as Model<AdminSession>,
    () => nowMs,
  );

  return {
    service,
    accountModel,
    sessionModel,
    setNow: (value: number) => {
      nowMs = value;
    },
    setAccount: (value: typeof activeAccount | null) => {
      account = value;
    },
    setSession: (value: { _id: Types.ObjectId } | null) => {
      session = value;
    },
    setAccountError: (value: Error) => {
      accountError = value;
    },
    setSessionError: (value: Error) => {
      sessionError = value;
    },
  };
};

describe('AdminAuthorizationStateService', () => {
  it('returns an immutable allowlisted principal and checks session every time', async () => {
    const { service, accountModel, sessionModel } = createContext();

    const first = await service.resolvePrincipal(validInput);
    const second = await service.resolvePrincipal(validInput);

    expect(first).toStrictEqual({
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
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toStrictEqual(first);
    expect(accountModel.findOne).toHaveBeenCalledTimes(1);
    expect(sessionModel.findOne).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first)).not.toContain('password');
    expect(JSON.stringify(first)).not.toContain('refresh');
  });

  it('converges stale account authorization before the four-second bound', async () => {
    const { service, setAccount, setNow, accountModel } = createContext();

    await expect(service.resolvePrincipal(validInput)).resolves.not.toBeNull();
    setAccount({ ...activeAccount, authzVersion: 4 });
    setNow(10_000 + ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS - 1);
    await expect(service.resolvePrincipal(validInput)).resolves.not.toBeNull();

    setNow(10_000 + ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS + 1);
    await expect(service.resolvePrincipal(validInput)).resolves.toBeNull();
    await expect(
      service.resolvePrincipal({ ...validInput, authzVersion: 4 }),
    ).resolves.not.toBeNull();
    expect(accountModel.findOne).toHaveBeenCalledTimes(2);
  });

  it('anchors cache freshness to load start and never extends a delayed stale read', async () => {
    let nowMs = 10_000;
    let resolveFirstLoad!: (value: typeof activeAccount) => void;
    const firstLoad = new Promise<typeof activeAccount>((resolve) => {
      resolveFirstLoad = resolve;
    });
    const accountModel = {
      findOne: jest
        .fn<() => QueryMock<typeof activeAccount | null>>()
        .mockImplementationOnce(() => createQuery(() => firstLoad))
        .mockImplementationOnce(() =>
          createQuery(() =>
            Promise.resolve({ ...activeAccount, authzVersion: 4 }),
          ),
        ),
    };
    const sessionModel = {
      findOne: jest.fn(() =>
        createQuery(() => Promise.resolve({ _id: new Types.ObjectId() })),
      ),
    };
    const service = new AdminAuthorizationStateService(
      accountModel as unknown as Model<AdminAccount>,
      sessionModel as unknown as Model<AdminSession>,
      () => nowMs,
    );

    const delayedRequest = service.resolvePrincipal(validInput);
    nowMs += ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS + 1;
    resolveFirstLoad(activeAccount);

    await expect(delayedRequest).resolves.not.toBeNull();
    await expect(service.resolvePrincipal(validInput)).resolves.toBeNull();
    await expect(
      service.resolvePrincipal({ ...validInput, authzVersion: 4 }),
    ).resolves.not.toBeNull();
    expect(accountModel.findOne).toHaveBeenCalledTimes(2);
  });

  it('invalidates the local account cache explicitly after a local commit', async () => {
    const { service, setAccount, accountModel } = createContext();

    await service.resolvePrincipal(validInput);
    setAccount({ ...activeAccount, permissionVersion: 5 });
    service.invalidateAdminAccount(ADMIN_ID);

    await expect(service.resolvePrincipal(validInput)).resolves.toBeNull();
    expect(accountModel.findOne).toHaveBeenCalledTimes(2);
  });

  it('rejects a revoked or expired session without waiting for account-cache expiry', async () => {
    const { service, setSession, sessionModel } = createContext();

    await expect(service.resolvePrincipal(validInput)).resolves.not.toBeNull();
    setSession(null);
    await expect(service.resolvePrincipal(validInput)).resolves.toBeNull();
    expect(sessionModel.findOne).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed input before database access', async () => {
    const { service, accountModel, sessionModel } = createContext();

    await expect(
      service.resolvePrincipal({ ...validInput, adminPublicId: 'usr_invalid' }),
    ).resolves.toBeNull();
    expect(accountModel.findOne).not.toHaveBeenCalled();
    expect(sessionModel.findOne).not.toHaveBeenCalled();
  });

  it.each(['account', 'session'] as const)(
    'fails closed with sanitized 503 on %s-store outage',
    async (store) => {
      const context = createContext();
      const failure = Object.assign(new Error('database unavailable'), {
        name: 'MongoServerSelectionError',
      });
      if (store === 'account') context.setAccountError(failure);
      else context.setSessionError(failure);

      await expect(
        context.service.resolvePrincipal(validInput),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    },
  );

  it('does not disguise programming errors as authentication failures', async () => {
    const context = createContext();
    const error = new TypeError('projection contract broken');
    context.setAccountError(error);

    await expect(context.service.resolvePrincipal(validInput)).rejects.toBe(
      error,
    );
  });
});
