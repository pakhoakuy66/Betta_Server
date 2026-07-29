import {
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { MockedFunction } from 'jest-mock';
import * as bcrypt from 'bcrypt';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';

import { USER_STATUS, User } from '../../users/schemas/user.schema';
import { GoogleOAuthAccountUnlinkUnavailableException } from '../exceptions/google-oauth-account-unlink-unavailable.exception';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditProvider,
  AuthAuditReasonCode,
} from '../interfaces/auth-audit.interface';
import { AuthAuditService } from './auth-audit.service';
import { GoogleOAuthAccountUnlinkService } from './google-oauth-account-unlink.service';
import { OAuthIdentityService } from './oauth-identity.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
}));

const NOW = new Date('2026-07-26T10:00:00.000Z');
const CURRENT_PASSWORD = 'Password@123';
const PASSWORD_HASH = 'stored-password-hash';

type CompareFunction = (
  value: string | Buffer,
  encrypted: string,
) => Promise<boolean>;

type PasswordUserResult = {
  _id: Types.ObjectId;
  password?: string;
} | null;

type ClaimedUserResult = {
  _id: Types.ObjectId;
} | null;

type QueryStub<T> = {
  select: jest.Mock<(fields: string) => QueryStub<T>>;
  lean: jest.Mock<() => QueryStub<T>>;
  exec: jest.Mock<() => Promise<T>>;
};

type FindOne = (
  filter: Record<string, unknown>,
) => QueryStub<PasswordUserResult>;

type FindOneAndUpdate = (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  options: Record<string, unknown>,
) => QueryStub<ClaimedUserResult>;

type ContextOptions = {
  passwordUser?: PasswordUserResult;
  claimedUser?: ClaimedUserResult;
  identityDeleted?: boolean;
};

const compareMock =
  bcrypt.compare as unknown as MockedFunction<CompareFunction>;

const createQuery = <T>(result: T): QueryStub<T> => {
  const query = {
    select: jest.fn<(fields: string) => QueryStub<T>>(),
    lean: jest.fn<() => QueryStub<T>>(),
    exec: jest.fn<() => Promise<T>>(() => Promise.resolve(result)),
  };

  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);

  return query;
};

const createContext = (options: ContextOptions = {}) => {
  const userId = new Types.ObjectId();

  const mongoSession = {
    inTransaction: jest.fn(() => true),
  } as unknown as ClientSession;

  const passwordUser =
    options.passwordUser === undefined
      ? {
          _id: userId,
          password: PASSWORD_HASH,
        }
      : options.passwordUser;

  const claimedUser =
    options.claimedUser === undefined
      ? {
          _id: userId,
        }
      : options.claimedUser;

  const passwordQuery = createQuery<PasswordUserResult>(passwordUser);
  const claimQuery = createQuery<ClaimedUserResult>(claimedUser);

  const findOne = jest.fn<FindOne>(() => passwordQuery);

  const findOneAndUpdate = jest.fn<FindOneAndUpdate>(() => claimQuery);

  const deleteGoogleIdentity = jest.fn<
    OAuthIdentityService['deleteGoogleIdentity']
  >(() => Promise.resolve(options.identityDeleted ?? true));

  const record = jest.fn<AuthAuditService['record']>(() => Promise.resolve());

  const transaction = jest.fn<Connection['transaction']>((work) =>
    work(mongoSession),
  );

  const service = new GoogleOAuthAccountUnlinkService(
    {
      transaction,
    } as unknown as Connection,
    {
      findOne,
      findOneAndUpdate,
    } as unknown as Model<User>,
    {
      deleteGoogleIdentity,
    } as unknown as OAuthIdentityService,
    {
      record,
    } as unknown as AuthAuditService,
  );

  return {
    service,
    userId,
    mongoSession,
    passwordQuery,
    claimQuery,
    findOne,
    findOneAndUpdate,
    deleteGoogleIdentity,
    record,
    transaction,
  };
};

describe('GoogleOAuthAccountUnlinkService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    compareMock.mockReset();
    compareMock.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('rejects invalid input before querying MongoDB', async () => {
    const context = createContext();

    await expect(
      context.service.unlinkGoogleAccount(
        'invalid' as unknown as Types.ObjectId,
        CURRENT_PASSWORD,
      ),
    ).rejects.toBeInstanceOf(TypeError);

    await expect(
      context.service.unlinkGoogleAccount(context.userId, ''),
    ).rejects.toBeInstanceOf(TypeError);

    expect(context.findOne).not.toHaveBeenCalled();
    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('unlinks identity and writes audit in one transaction', async () => {
    const context = createContext();

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).resolves.toBeUndefined();

    expect(context.findOne).toHaveBeenCalledWith({
      _id: context.userId,
      isDeleted: false,
      status: USER_STATUS.ACTIVE,
      $or: [
        {
          lockedUntil: null,
        },
        {
          lockedUntil: {
            $lte: NOW,
          },
        },
        {
          lockedUntil: {
            $exists: false,
          },
        },
      ],
    });

    expect(context.passwordQuery.select).toHaveBeenCalledWith('_id +password');

    expect(compareMock).toHaveBeenCalledWith(CURRENT_PASSWORD, PASSWORD_HASH);

    expect(context.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: context.userId,
        isDeleted: false,
        status: USER_STATUS.ACTIVE,
        $or: [
          {
            lockedUntil: null,
          },
          {
            lockedUntil: {
              $lte: NOW,
            },
          },
          {
            lockedUntil: {
              $exists: false,
            },
          },
        ],
        password: PASSWORD_HASH,
      },
      {
        $set: {
          updatedAt: NOW,
        },
      },
      {
        returnDocument: 'after',
        projection: {
          _id: 1,
        },
        session: context.mongoSession,
      },
    );

    expect(context.deleteGoogleIdentity).toHaveBeenCalledWith(
      context.userId,
      context.mongoSession,
    );

    expect(context.record).toHaveBeenCalledWith({
      eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
      outcome: AuthAuditOutcome.SUCCEEDED,
      reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_UNLINKED,
      targetUserId: context.userId,
      actorUserId: context.userId,
      metadata: {
        provider: AuthAuditProvider.GOOGLE,
      },
      mongoSession: context.mongoSession,
    });
  });

  it('runs password verification before opening transaction', async () => {
    const context = createContext();

    await context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD);

    const compareOrder = compareMock.mock.invocationCallOrder[0];
    const transactionOrder = context.transaction.mock.invocationCallOrder[0];

    expect(compareOrder).toBeLessThan(transactionOrder);
  });

  it('rejects a passwordless account before bcrypt and transaction', async () => {
    const context = createContext({
      passwordUser: {
        _id: new Types.ObjectId(),
      },
    });

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(compareMock).not.toHaveBeenCalled();
    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('rejects an incorrect password before transaction', async () => {
    const context = createContext();
    compareMock.mockResolvedValueOnce(false);

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('rejects an unavailable account before bcrypt and transaction', async () => {
    const context = createContext({
      passwordUser: null,
    });

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(GoogleOAuthAccountUnlinkUnavailableException);

    expect(compareMock).not.toHaveBeenCalled();
    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('rejects when password or account state changes before claim', async () => {
    const context = createContext({
      claimedUser: null,
    });

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(GoogleOAuthAccountUnlinkUnavailableException);

    expect(context.deleteGoogleIdentity).not.toHaveBeenCalled();
    expect(context.record).not.toHaveBeenCalled();
  });

  it('does not audit when Google identity is missing', async () => {
    const context = createContext({
      identityDeleted: false,
    });

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(GoogleOAuthAccountUnlinkUnavailableException);

    expect(context.record).not.toHaveBeenCalled();
  });

  it('propagates audit failure so transaction can roll back', async () => {
    const context = createContext();
    const auditError = new Error('audit unavailable');

    context.record.mockRejectedValueOnce(auditError);

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).rejects.toBe(auditError);

    expect(context.deleteGoogleIdentity).toHaveBeenCalledTimes(1);
  });

  it('maps initial MongoDB infrastructure failure to 503', async () => {
    const context = createContext();

    context.passwordQuery.exec.mockRejectedValueOnce(
      Object.assign(new Error('database unavailable'), {
        name: 'MongoNetworkError',
      }),
    );

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('maps in-transaction MongoDB infrastructure failure to 503', async () => {
    const context = createContext();

    context.claimQuery.exec.mockRejectedValueOnce(
      Object.assign(new Error('transaction unavailable'), {
        errorLabels: ['TransientTransactionError'],
      }),
    );

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not hide unknown programming errors', async () => {
    const context = createContext();
    const programmingError = new TypeError('invalid internal state');

    context.deleteGoogleIdentity.mockRejectedValueOnce(programmingError);

    await expect(
      context.service.unlinkGoogleAccount(context.userId, CURRENT_PASSWORD),
    ).rejects.toBe(programmingError);
  });
});
