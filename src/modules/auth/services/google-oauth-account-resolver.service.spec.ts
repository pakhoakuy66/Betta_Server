import {
  HttpException,
  HttpStatus,
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
import { type Model, Types } from 'mongoose';

import {
  USER_STATUS,
  User,
  type UserStatus,
} from '../../users/schemas/user.schema';
import {
  GOOGLE_OAUTH_INTERNAL_USER_ID,
  GoogleOAuthAccountResolutionStatus,
} from '../interfaces/google-oauth-account-resolution.interface';
import type { GoogleOAuthVerifiedIdentity } from '../interfaces/google-oauth-provider.interface';
import { GoogleOAuthAccountResolverService } from './google-oauth-account-resolver.service';
import { OAuthIdentityService } from './oauth-identity.service';

const NOW = new Date('2026-07-22T08:00:00.000Z');

type AccountRecord = {
  _id: Types.ObjectId;
  isDeleted: boolean;
  status: UserStatus;
  lockedUntil?: Date | null;
};

type QueryStub<T> = {
  select: jest.Mock<(selection: string) => QueryStub<T>>;
  lean: jest.Mock<() => QueryStub<T>>;
  exec: jest.Mock<() => Promise<T>>;
};

type ContextOptions = {
  linkedUserId?: Types.ObjectId | null;
  linkedUser?: AccountRecord | null;
  emailUser?: AccountRecord | null;
};

const createQueryStub = <T>(result: T): QueryStub<T> => {
  const query = {
    select: jest.fn<(selection: string) => QueryStub<T>>(),
    lean: jest.fn<() => QueryStub<T>>(),
    exec: jest.fn<() => Promise<T>>(() => Promise.resolve(result)),
  };

  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);

  return query;
};

const createAccount = (
  overrides: Partial<AccountRecord> = {},
): AccountRecord => ({
  _id: new Types.ObjectId(),
  isDeleted: false,
  status: USER_STATUS.ACTIVE,
  lockedUntil: null,
  ...overrides,
});

const createIdentity = (
  overrides: Partial<GoogleOAuthVerifiedIdentity> = {},
): GoogleOAuthVerifiedIdentity => ({
  providerAccountId: 'google-subject-123',
  email: 'user@example.com',
  fullname: 'Betta User',
  avatar: 'https://example.com/avatar.jpg',
  ...overrides,
});

const createContext = ({
  linkedUserId = null,
  linkedUser = null,
  emailUser = null,
}: ContextOptions = {}) => {
  const linkedUserQuery = createQueryStub<AccountRecord | null>(linkedUser);

  const emailUserQuery = createQueryStub<AccountRecord | null>(emailUser);

  const findById = jest.fn<
    (userId: Types.ObjectId) => QueryStub<AccountRecord | null>
  >(() => linkedUserQuery);

  const findOne = jest.fn<
    (filter: Record<string, unknown>) => QueryStub<AccountRecord | null>
  >(() => emailUserQuery);

  const resolveGoogleUserId = jest.fn<
    OAuthIdentityService['resolveGoogleUserId']
  >(() => Promise.resolve(linkedUserId));

  const oauthIdentityService = {
    resolveGoogleUserId,
  } as unknown as OAuthIdentityService;

  const userModel = {
    findById,
    findOne,
  } as unknown as Model<User>;

  const service = new GoogleOAuthAccountResolverService(
    userModel,
    oauthIdentityService,
  );

  return {
    service,
    findById,
    findOne,
    linkedUserQuery,
    emailUserQuery,
    resolveGoogleUserId,
  };
};

const expectLockedAccount = async (
  operation: Promise<unknown>,
  expectedRetryAfterSeconds: number,
): Promise<void> => {
  let caughtError: unknown;

  try {
    await operation;
  } catch (error: unknown) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(HttpException);

  if (!(caughtError instanceof HttpException)) {
    throw new Error('Expected account resolution to throw HttpException');
  }

  expect(caughtError.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

  expect(caughtError.getResponse()).toEqual(
    expect.objectContaining({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      retryAfterSeconds: expectedRetryAfterSeconds,
    }),
  );
};

describe('GoogleOAuthAccountResolverService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('linked Google identity', () => {
    it('returns SIGN_IN for an active linked user', async () => {
      const user = createAccount();

      const context = createContext({
        linkedUserId: user._id,
        linkedUser: user,
      });

      const result = await context.service.resolve(createIdentity());

      expect(result).toEqual({
        status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
        [GOOGLE_OAUTH_INTERNAL_USER_ID]: user._id,
      });

      expect(context.resolveGoogleUserId).toHaveBeenCalledWith(
        'google-subject-123',
      );

      expect(context.findById).toHaveBeenCalledWith(user._id);

      expect(context.linkedUserQuery.select).toHaveBeenCalledWith(
        '_id isDeleted status +lockedUntil',
      );

      expect(context.findOne).not.toHaveBeenCalled();
    });

    it('keeps internal user id outside JSON serialization', async () => {
      const user = createAccount();

      const { service } = createContext({
        linkedUserId: user._id,
        linkedUser: user,
      });

      const result = await service.resolve(createIdentity());

      expect(Object.hasOwn(result, GOOGLE_OAUTH_INTERNAL_USER_ID)).toBe(true);

      const serialized = JSON.stringify(result);

      expect(serialized).toBe(
        JSON.stringify({
          status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
        }),
      );

      expect(serialized).not.toContain(user._id.toString());
    });

    it('fails closed for a dangling linked identity', async () => {
      const linkedUserId = new Types.ObjectId();

      const context = createContext({
        linkedUserId,
        linkedUser: null,
      });

      await expect(
        context.service.resolve(createIdentity()),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(context.findById).toHaveBeenCalledWith(linkedUserId);

      expect(context.findOne).not.toHaveBeenCalled();
    });

    it.each([
      [
        'deleted',
        {
          isDeleted: true,
          status: USER_STATUS.ACTIVE,
        },
      ],
      [
        'banned',
        {
          isDeleted: false,
          status: USER_STATUS.BANNED,
        },
      ],
      [
        'reported',
        {
          isDeleted: false,
          status: USER_STATUS.REPORTED,
        },
      ],
      [
        'unknown status',
        {
          isDeleted: false,
          status: 'suspended' as UserStatus,
        },
      ],
    ])('rejects a linked %s account', async (_caseName, overrides) => {
      const user = createAccount(overrides);

      const context = createContext({
        linkedUserId: user._id,
        linkedUser: user,
      });

      await expect(
        context.service.resolve(createIdentity()),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(context.findOne).not.toHaveBeenCalled();
    });

    it('rejects a currently locked linked account', async () => {
      const user = createAccount({
        lockedUntil: new Date(NOW.getTime() + 5 * 60 * 1_000),
      });

      const { service } = createContext({
        linkedUserId: user._id,
        linkedUser: user,
      });

      await expectLockedAccount(service.resolve(createIdentity()), 300);
    });

    it('allows a linked account whose lock has expired', async () => {
      const user = createAccount({
        lockedUntil: new Date(NOW.getTime() - 1),
      });

      const { service } = createContext({
        linkedUserId: user._id,
        linkedUser: user,
      });

      await expect(service.resolve(createIdentity())).resolves.toEqual({
        status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
        [GOOGLE_OAUTH_INTERNAL_USER_ID]: user._id,
      });
    });

    it('treats a lock expiring exactly now as expired', async () => {
      const user = createAccount({
        lockedUntil: new Date(NOW),
      });

      const { service } = createContext({
        linkedUserId: user._id,
        linkedUser: user,
      });

      await expect(service.resolve(createIdentity())).resolves.toEqual({
        status: GoogleOAuthAccountResolutionStatus.SIGN_IN,
        [GOOGLE_OAUTH_INTERNAL_USER_ID]: user._id,
      });
    });
  });

  describe('existing account without Google identity', () => {
    it('returns ACCOUNT_LINK_REQUIRED with the exact internal user id', async () => {
      const existingUser = createAccount();

      const context = createContext({
        linkedUserId: null,
        emailUser: existingUser,
      });

      const result = await context.service.resolve(
        createIdentity({
          email: ' USER@EXAMPLE.COM ',
        }),
      );

      expect(result).toEqual({
        status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,
        email: 'user@example.com',
        [GOOGLE_OAUTH_INTERNAL_USER_ID]: existingUser._id,
      });

      const serialized = JSON.stringify(result);

      expect(serialized).toBe(
        JSON.stringify({
          status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,
          email: 'user@example.com',
        }),
      );

      expect(serialized).not.toContain(existingUser._id.toString());

      expect(context.findOne).toHaveBeenCalledWith({
        email: 'user@example.com',
      });

      expect(context.emailUserQuery.select).toHaveBeenCalledWith(
        '_id isDeleted status +lockedUntil',
      );

      expect(context.findById).not.toHaveBeenCalled();
    });

    it.each([
      [
        'deleted',
        {
          isDeleted: true,
          status: USER_STATUS.ACTIVE,
        },
      ],
      [
        'banned',
        {
          isDeleted: false,
          status: USER_STATUS.BANNED,
        },
      ],
      [
        'reported',
        {
          isDeleted: false,
          status: USER_STATUS.REPORTED,
        },
      ],
      [
        'unknown status',
        {
          isDeleted: false,
          status: 'suspended' as UserStatus,
        },
      ],
    ])('rejects an existing %s account', async (_caseName, overrides) => {
      const context = createContext({
        emailUser: createAccount(overrides),
      });

      await expect(
        context.service.resolve(createIdentity()),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(context.findById).not.toHaveBeenCalled();
    });

    it('rejects a currently locked existing account', async () => {
      const user = createAccount({
        lockedUntil: new Date(NOW.getTime() + 90_500),
      });

      const { service } = createContext({
        emailUser: user,
      });

      await expectLockedAccount(service.resolve(createIdentity()), 91);
    });

    it('allows linking after the existing account lock expires', async () => {
      const user = createAccount({
        lockedUntil: new Date(NOW.getTime() - 60_000),
      });

      const { service } = createContext({
        emailUser: user,
      });

      await expect(service.resolve(createIdentity())).resolves.toEqual({
        status: GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED,
        email: 'user@example.com',
        [GOOGLE_OAUTH_INTERNAL_USER_ID]: user._id,
      });
    });
  });

  describe('new Google account', () => {
    it('returns REGISTRATION_REQUIRED without exposing subject', async () => {
      const context = createContext();

      const result = await context.service.resolve(
        createIdentity({
          email: ' NEW.USER@EXAMPLE.COM ',
          fullname: 'New User',
          avatar: 'https://example.com/new-avatar.jpg',
        }),
      );

      expect(result).toEqual({
        status: GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED,
        profile: {
          email: 'new.user@example.com',
          fullname: 'New User',
          avatar: 'https://example.com/new-avatar.jpg',
        },
      });

      expect(result).not.toHaveProperty('providerAccountId');

      expect(JSON.stringify(result)).not.toContain('google-subject-123');

      expect(context.findOne).toHaveBeenCalledWith({
        email: 'new.user@example.com',
      });

      expect(context.findById).not.toHaveBeenCalled();
    });

    it('preserves nullable Google profile fields', async () => {
      const { service } = createContext();

      await expect(
        service.resolve(
          createIdentity({
            fullname: null,
            avatar: null,
          }),
        ),
      ).resolves.toEqual({
        status: GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED,
        profile: {
          email: 'user@example.com',
          fullname: null,
          avatar: null,
        },
      });
    });
  });

  describe('security and infrastructure boundaries', () => {
    it('rejects whitespace email before any database query', async () => {
      const context = createContext();

      await expect(
        context.service.resolve(
          createIdentity({
            email: '   ',
          }),
        ),
      ).rejects.toThrow('Verified Google identity requires an email');

      expect(context.resolveGoogleUserId).not.toHaveBeenCalled();

      expect(context.findById).not.toHaveBeenCalled();
      expect(context.findOne).not.toHaveBeenCalled();
    });

    it('propagates identity lookup infrastructure errors', async () => {
      const databaseError = new Error('identity database unavailable');

      const context = createContext();

      context.resolveGoogleUserId.mockRejectedValueOnce(databaseError);

      await expect(context.service.resolve(createIdentity())).rejects.toBe(
        databaseError,
      );

      expect(context.findById).not.toHaveBeenCalled();
      expect(context.findOne).not.toHaveBeenCalled();
    });

    it('propagates linked-user lookup infrastructure errors', async () => {
      const linkedUserId = new Types.ObjectId();

      const databaseError = new Error('user database unavailable');

      const context = createContext({
        linkedUserId,
      });

      context.linkedUserQuery.exec.mockRejectedValueOnce(databaseError);

      await expect(context.service.resolve(createIdentity())).rejects.toBe(
        databaseError,
      );

      expect(context.findOne).not.toHaveBeenCalled();
    });

    it('propagates email lookup infrastructure errors', async () => {
      const databaseError = new Error('email lookup unavailable');

      const context = createContext();

      context.emailUserQuery.exec.mockRejectedValueOnce(databaseError);

      await expect(context.service.resolve(createIdentity())).rejects.toBe(
        databaseError,
      );

      expect(context.findById).not.toHaveBeenCalled();
    });
  });
});
