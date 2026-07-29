import {
  HttpException,
  HttpStatus,
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
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';

import {
  DEFAULT_AVATAR_ID,
  DEFAULT_AVATAR_URL,
  DEFAULT_NOTIFICATION_SETTINGS,
  USER_STATUS,
  User,
  type NotificationSettings,
  type UserStatus,
} from '../../users/schemas/user.schema';
import type { SessionRequestMetadata } from '../interfaces/auth-session.interface';
import { AuthSessionService } from './auth-session.service';
import { GoogleOAuthSignInService } from './google-oauth-sign-in.service';
import { OAuthIdentityService } from './oauth-identity.service';
import type { IssuedGoogleOAuthSessionHandoff } from '../interfaces/google-oauth-session-handoff.interface';
import { GoogleOAuthSessionHandoffService } from './google-oauth-session-handoff.service';

const NOW = new Date('2026-07-25T08:00:00.000Z');
const GOOGLE_SUBJECT = 'google-subject-123';
const HANDOFF: IssuedGoogleOAuthSessionHandoff = {
  rawHandoff: Buffer.alloc(32, 4).toString('base64url'),
  expiresAt: new Date('2026-07-26T08:02:00.000Z'),
};

type AuthenticatedUserRecord = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  email: string;
  phone: string;
  avatar?: string;
  avatarId?: string;
  streakCount?: number;
  status?: typeof USER_STATUS.ACTIVE;
  notificationSettings?: NotificationSettings;
};

type AccountState = {
  isDeleted: boolean;
  status: UserStatus;
  lockedUntil?: Date | null;
};

type QueryStub<T> = {
  select: jest.Mock<(selection: unknown) => QueryStub<T>>;
  lean: jest.Mock<() => QueryStub<T>>;
  exec: jest.Mock<() => Promise<T>>;
};

type FindOneAndUpdate = (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  options: Record<string, unknown>,
) => QueryStub<AuthenticatedUserRecord | null>;

type FindById = (userId: Types.ObjectId) => QueryStub<AccountState | null>;

type Transaction = <T>(
  work: (session: ClientSession) => Promise<T>,
) => Promise<T>;

const createQuery = <T>(result: T): QueryStub<T> => {
  const query = {
    select: jest.fn<(selection: unknown) => QueryStub<T>>(),
    lean: jest.fn<() => QueryStub<T>>(),
    exec: jest.fn<() => Promise<T>>(() => Promise.resolve(result)),
  };

  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);

  return query;
};

const createContext = () => {
  const mongoSession = {} as ClientSession;

  const expectedUserId = new Types.ObjectId();

  const user: AuthenticatedUserRecord = {
    _id: expectedUserId,
    publicId: 'usr_GoogleSignIn1',
    username: 'google_sign_in',
    fullname: 'Google Sign In',
    email: 'google.signin@example.com',
    phone: '0912345678',
    avatarId: DEFAULT_AVATAR_ID,
    avatar: DEFAULT_AVATAR_URL,
    streakCount: 3,
    status: USER_STATUS.ACTIVE,
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
  };

  const selectedUserQuery = createQuery<AuthenticatedUserRecord | null>(user);

  const accountStateQuery = createQuery<AccountState | null>(null);

  const findOneAndUpdate = jest.fn<FindOneAndUpdate>(() => selectedUserQuery);

  const findById = jest.fn<FindById>(() => accountStateQuery);

  const resolveGoogleUserId = jest.fn<
    OAuthIdentityService['resolveGoogleUserId']
  >(() => Promise.resolve(expectedUserId));

  const createSession = jest.fn<AuthSessionService['createSession']>(() =>
    Promise.resolve({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    }),
  );

  const issueHandoff = jest.fn<GoogleOAuthSessionHandoffService['issue']>(() =>
    Promise.resolve(HANDOFF),
  );

  const transaction = jest.fn<Transaction>((work) => work(mongoSession));

  const service = new GoogleOAuthSignInService(
    {
      transaction,
    } as unknown as Connection,
    {
      findOneAndUpdate,
      findById,
    } as unknown as Model<User>,
    {
      resolveGoogleUserId,
    } as unknown as OAuthIdentityService,
    {
      createSession,
    } as unknown as AuthSessionService,
    {
      issue: issueHandoff,
    } as unknown as GoogleOAuthSessionHandoffService,
  );

  const metadata: SessionRequestMetadata = {
    userAgent: 'Unit Test Chrome',
  };

  const signIn = () =>
    service.signInLinkedAccount(GOOGLE_SUBJECT, expectedUserId, metadata);

  return {
    service,
    signIn,
    metadata,
    user,
    expectedUserId,
    mongoSession,
    transaction,
    findOneAndUpdate,
    findById,
    selectedUserQuery,
    accountStateQuery,
    resolveGoogleUserId,
    createSession,
    issueHandoff,
  };
};

describe('GoogleOAuthSignInService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('signs in a linked active account in one transaction', async () => {
    const context = createContext();

    const result = await context.signIn();

    expect(result).toEqual(HANDOFF);

    expect(context.issueHandoff).toHaveBeenCalledWith(
      {
        message: 'Đăng nhập bằng Google thành công',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        user: {
          id: context.user.publicId,
          publicId: context.user.publicId,
          username: context.user.username,
          fullname: context.user.fullname,
          email: context.user.email,
          phone: context.user.phone,
          avatar: context.user.avatar ?? null,
          hasCustomAvatar: false,
          streakCount: 3,
          status: USER_STATUS.ACTIVE,
          notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
        },
      },
      context.mongoSession,
    );

    expect(context.resolveGoogleUserId).toHaveBeenCalledWith(
      GOOGLE_SUBJECT,
      context.mongoSession,
    );

    expect(context.createSession).toHaveBeenCalledWith(
      context.user,
      context.metadata,
      context.mongoSession,
    );

    expect(context.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: context.expectedUserId,
        isDeleted: false,
        status: USER_STATUS.ACTIVE,
        $or: expect.any(Array),
      }),
      {
        $set: {
          failedLoginAttempts: 0,
        },
        $unset: {
          failedLoginWindowStartedAt: '',
          lockedUntil: '',
        },
      },
      {
        session: context.mongoSession,
        returnDocument: 'after',
        runValidators: true,
      },
    );

    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(context.expectedUserId.toString());
    expect(serialized).not.toContain(GOOGLE_SUBJECT);
    expect(serialized).not.toContain('failedLoginAttempts');
    expect(serialized).not.toContain('lockedUntil');
  });

  it('propagates handoff issuance failure for transaction rollback', async () => {
    const context = createContext();
    const error = new ServiceUnavailableException();

    context.issueHandoff.mockRejectedValueOnce(error);

    await expect(context.signIn()).rejects.toBe(error);

    expect(context.createSession).toHaveBeenCalled();
  });

  it('rejects an identity linked to another user', async () => {
    const context = createContext();

    context.resolveGoogleUserId.mockResolvedValueOnce(new Types.ObjectId());

    await expect(context.signIn()).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(context.findOneAndUpdate).not.toHaveBeenCalled();
    expect(context.createSession).not.toHaveBeenCalled();
  });

  it('rejects a missing Google identity', async () => {
    const context = createContext();

    context.resolveGoogleUserId.mockResolvedValueOnce(null);

    await expect(context.signIn()).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(context.findOneAndUpdate).not.toHaveBeenCalled();
    expect(context.createSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      'deleted',
      {
        isDeleted: true,
        status: USER_STATUS.ACTIVE,
        lockedUntil: null,
      },
    ],
    [
      'banned',
      {
        isDeleted: false,
        status: USER_STATUS.BANNED,
        lockedUntil: null,
      },
    ],
    [
      'reported',
      {
        isDeleted: false,
        status: USER_STATUS.REPORTED,
        lockedUntil: null,
      },
    ],
  ])('rejects a %s linked account', async (_caseName, accountState) => {
    const context = createContext();

    context.selectedUserQuery.exec.mockResolvedValueOnce(null);

    context.accountStateQuery.exec.mockResolvedValueOnce(accountState);

    await expect(context.signIn()).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(context.createSession).not.toHaveBeenCalled();
  });

  it('returns 429 for a currently locked account', async () => {
    const context = createContext();

    context.selectedUserQuery.exec.mockResolvedValueOnce(null);

    context.accountStateQuery.exec.mockResolvedValueOnce({
      isDeleted: false,
      status: USER_STATUS.ACTIVE,
      lockedUntil: new Date(NOW.getTime() + 5 * 60_000),
    });

    let caughtError: unknown;

    try {
      await context.signIn();
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(HttpException);

    if (!(caughtError instanceof HttpException)) {
      throw new Error('Expected HttpException');
    }

    expect(caughtError.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

    expect(caughtError.getResponse()).toEqual(
      expect.objectContaining({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        retryAfterSeconds: 300,
      }),
    );

    expect(context.createSession).not.toHaveBeenCalled();
  });

  it.each(['', 'subject with spaces', 'x'.repeat(256)])(
    'rejects invalid Google subject before transaction',
    async (subject) => {
      const context = createContext();

      await expect(
        context.service.signInLinkedAccount(
          subject,
          context.expectedUserId,
          context.metadata,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      expect(context.transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid expected user id before transaction', async () => {
    const context = createContext();

    await expect(
      context.service.signInLinkedAccount(
        GOOGLE_SUBJECT,
        'invalid-id' as unknown as Types.ObjectId,
        context.metadata,
      ),
    ).rejects.toBeInstanceOf(TypeError);

    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('maps MongoDB infrastructure errors to 503', async () => {
    const context = createContext();

    const databaseError = Object.assign(new Error('database unavailable'), {
      name: 'MongoNetworkError',
    });

    context.transaction.mockRejectedValueOnce(databaseError);

    await expect(context.signIn()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('propagates session creation failure for transaction rollback', async () => {
    const context = createContext();
    const sessionError = new Error('session persistence failed');

    context.createSession.mockRejectedValueOnce(sessionError);

    await expect(context.signIn()).rejects.toBe(sessionError);
  });
});
