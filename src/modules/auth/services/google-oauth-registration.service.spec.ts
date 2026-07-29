import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
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
} from '../../users/schemas/user.schema';
import type { CompleteGoogleOAuthRegistrationDto } from '../dto/complete-google-oauth-registration.dto';
import { AuthSessionService } from './auth-session.service';
import { GoogleOAuthContinuationGrantService } from './google-oauth-continuation-grant.service';
import { GoogleOAuthRegistrationService } from './google-oauth-registration.service';
import { OAuthIdentityService } from './oauth-identity.service';

const RAW_GRANT = 'a'.repeat(43);

type QueryStub<T> = {
  select: jest.Mock<(projection: unknown) => QueryStub<T>>;
  session: jest.Mock<(session: ClientSession) => QueryStub<T>>;
  lean: jest.Mock<() => QueryStub<T>>;
  exec: jest.Mock<() => Promise<T>>;
};

const createQuery = <T>(result: T): QueryStub<T> => {
  const query = {
    select: jest.fn<(projection: unknown) => QueryStub<T>>(),
    session: jest.fn<(session: ClientSession) => QueryStub<T>>(),
    lean: jest.fn<() => QueryStub<T>>(),
    exec: jest.fn<() => Promise<T>>(() => Promise.resolve(result)),
  };

  query.select.mockReturnValue(query);
  query.session.mockReturnValue(query);
  query.lean.mockReturnValue(query);

  return query;
};

type FindOne = (filter: Record<string, unknown>) => QueryStub<{
  _id: Types.ObjectId;
} | null>;

type CreateUsers = (
  documents: Array<Record<string, unknown>>,
  options: { session: ClientSession },
) => Promise<User[]>;

type Transaction = <T>(
  work: (session: ClientSession) => Promise<T>,
) => Promise<T>;

const createContext = () => {
  const mongoSession = {
    inTransaction: jest.fn(() => true),
  } as unknown as ClientSession;

  const userId = new Types.ObjectId();
  const user = {
    _id: userId,
    publicId: 'usr_Google123',
    username: 'google_user',
    fullname: 'Google User',
    email: 'google.user@example.com',
    phone: '0912345678',
    avatarId: DEFAULT_AVATAR_ID,
    avatar: DEFAULT_AVATAR_URL,
    streakCount: 0,
    status: USER_STATUS.ACTIVE,
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
  } as User;

  const duplicateQuery = createQuery<{ _id: Types.ObjectId } | null>(null);
  const findOne = jest.fn<FindOne>(() => duplicateQuery);
  const create = jest.fn<CreateUsers>(() => Promise.resolve([user]));

  const consumeRegistrationGrant = jest.fn<
    GoogleOAuthContinuationGrantService['consumeRegistrationGrant']
  >(() =>
    Promise.resolve({
      providerAccountId: 'google-subject-123',
      email: 'google.user@example.com',
      fullname: 'Google User',
      avatar: 'https://example.com/avatar.png',
    }),
  );

  const resolveGoogleUserId = jest.fn<
    OAuthIdentityService['resolveGoogleUserId']
  >(() => Promise.resolve(null));

  const createGoogleIdentity = jest.fn<
    OAuthIdentityService['createGoogleIdentity']
  >(() => Promise.resolve());

  const createSession = jest.fn<AuthSessionService['createSession']>(() =>
    Promise.resolve({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    }),
  );

  const transaction = jest.fn<Transaction>((work) => work(mongoSession));

  const service = new GoogleOAuthRegistrationService(
    { transaction } as unknown as Connection,
    { findOne, create } as unknown as Model<User>,
    {
      consumeRegistrationGrant,
    } as unknown as GoogleOAuthContinuationGrantService,
    {
      resolveGoogleUserId,
      createGoogleIdentity,
    } as unknown as OAuthIdentityService,
    { createSession } as unknown as AuthSessionService,
  );

  const input: CompleteGoogleOAuthRegistrationDto = {
    username: ' google_user ',
    phone: ' 0912345678 ',
  };

  const complete = () =>
    service.completeRegistration(RAW_GRANT, input, {
      userAgent: 'Unit test browser',
    });

  return {
    service,
    input,
    complete,
    mongoSession,
    user,
    duplicateQuery,
    findOne,
    create,
    transaction,
    consumeRegistrationGrant,
    resolveGoogleUserId,
    createGoogleIdentity,
    createSession,
  };
};

describe('GoogleOAuthRegistrationService', () => {
  it('creates user, identity and session in the same transaction', async () => {
    const context = createContext();

    await expect(context.complete()).resolves.toMatchObject({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      user: {
        id: context.user.publicId,
        email: context.user.email,
      },
    });

    expect(context.consumeRegistrationGrant).toHaveBeenCalledWith(
      RAW_GRANT,
      context.mongoSession,
    );

    const [documents, options] = context.create.mock.calls[0];

    expect(documents[0]).not.toHaveProperty('password');
    expect(documents[0]).toMatchObject({
      username: 'google_user',
      phone: '0912345678',
      email: 'google.user@example.com',
      fullname: 'Google User',
    });
    expect(options.session).toBe(context.mongoSession);

    expect(context.createGoogleIdentity).toHaveBeenCalledWith(
      context.user._id,
      'google-subject-123',
      context.mongoSession,
    );
    expect(context.createSession).toHaveBeenCalledWith(
      context.user,
      { userAgent: 'Unit test browser' },
      context.mongoSession,
    );
  });

  it('rejects an invalid supplied fullname before opening a transaction', async () => {
    const context = createContext();

    await expect(
      context.service.completeRegistration(
        RAW_GRANT,
        {
          ...context.input,
          fullname: 'Invalid\u0000Name',
        },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('requires fullname when neither input nor grant has a safe value', async () => {
    const context = createContext();

    context.consumeRegistrationGrant.mockResolvedValueOnce({
      providerAccountId: 'google-subject-123',
      email: 'google.user@example.com',
      fullname: null,
      avatar: null,
    });

    await expect(context.complete()).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(context.create).not.toHaveBeenCalled();
  });

  it('uses a supplied fullname when the grant has no safe name', async () => {
    const context = createContext();

    context.consumeRegistrationGrant.mockResolvedValueOnce({
      providerAccountId: 'google-subject-123',
      email: 'google.user@example.com',
      fullname: null,
      avatar: null,
    });

    await context.service.completeRegistration(
      RAW_GRANT,
      {
        ...context.input,
        fullname: ' Supplied Name ',
      },
      {},
    );

    expect(context.create.mock.calls[0][0][0]).toMatchObject({
      fullname: 'Supplied Name',
    });
  });

  it('rejects a duplicate user before identity and user creation', async () => {
    const context = createContext();

    context.duplicateQuery.exec.mockResolvedValueOnce({
      _id: new Types.ObjectId(),
    });

    await expect(context.complete()).rejects.toBeInstanceOf(ConflictException);
    expect(context.resolveGoogleUserId).not.toHaveBeenCalled();
    expect(context.create).not.toHaveBeenCalled();
  });

  it('rejects a Google subject that is already linked', async () => {
    const context = createContext();

    context.resolveGoogleUserId.mockResolvedValueOnce(new Types.ObjectId());

    await expect(context.complete()).rejects.toBeInstanceOf(ConflictException);
    expect(context.create).not.toHaveBeenCalled();
  });

  it.each([
    [11000, { email: 1 }],
    ['11000', { username: 1 }],
    [11000, { phone: 1 }],
  ])('maps an owned duplicate field to conflict', async (code, keyPattern) => {
    const context = createContext();

    context.create.mockRejectedValueOnce({ code, keyPattern });

    await expect(context.complete()).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    [11000, { publicId: 1 }],
    ['11000', { tokenFamily: 1 }],
    [11000, undefined],
  ])(
    'maps an internal or unknown duplicate to unavailable',
    async (code, keyPattern) => {
      const context = createContext();

      context.create.mockRejectedValueOnce({ code, keyPattern });

      await expect(context.complete()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    },
  );

  it('propagates identity failure so the transaction can roll back', async () => {
    const context = createContext();
    const error = new Error('identity persistence failed');

    context.createGoogleIdentity.mockRejectedValueOnce(error);

    await expect(context.complete()).rejects.toBe(error);
    expect(context.createSession).not.toHaveBeenCalled();
  });

  it('propagates session failure so the transaction can roll back', async () => {
    const context = createContext();
    const error = new Error('session persistence failed');

    context.createSession.mockRejectedValueOnce(error);

    await expect(context.complete()).rejects.toBe(error);
  });

  it('maps MongoDB infrastructure failures to unavailable', async () => {
    const context = createContext();
    const error = Object.assign(new Error('database unavailable'), {
      name: 'MongoNetworkError',
    });

    context.consumeRegistrationGrant.mockRejectedValueOnce(error);

    await expect(context.complete()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not hide unknown programming errors', async () => {
    const context = createContext();
    const error = new TypeError('invalid internal state');

    context.resolveGoogleUserId.mockRejectedValueOnce(error);

    await expect(context.complete()).rejects.toBe(error);
  });
});
