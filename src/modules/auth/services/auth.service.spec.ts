import {
  BadRequestException,
  ConflictException,
  HttpException,
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
import type { Mock, MockedFunction } from 'jest-mock';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection } from 'mongoose';
import * as bcrypt from 'bcrypt';
import {
  DEFAULT_AVATAR_ID,
  type NotificationSettings,
  User,
} from '../../users/schemas/user.schema';
import { SessionRevokeReason } from '../schemas/auth-session.schema';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { AuthSessionService } from './auth-session.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

type HashFunction = (
  value: string | Buffer,
  rounds: string | number,
) => Promise<string>;

type CompareFunction = (
  value: string | Buffer,
  encrypted: string,
) => Promise<boolean>;

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type ModelMethod = Mock<(...args: unknown[]) => unknown>;

type UserModelMock = {
  findOne: ModelMethod;
  findOneAndUpdate: ModelMethod;
  findById: ModelMethod;
  updateOne: ModelMethod;
  create: Mock<(document: unknown) => Promise<unknown>>;
};

type UserFixture = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  fullname: string;
  phone: string;
  email: string;
  password: string;
  avatar: string | null;
  avatarId: string;
  streakCount: number;
  status: string;
  isDeleted: boolean;
  notificationSettings: NotificationSettings;
  refreshToken?: string | null;
  failedLoginAttempts?: number;
  failedLoginWindowStartedAt?: Date | null;
  lockedUntil?: Date | null;
  forgotPasswordOtp?: string;
  forgotPasswordExpiry?: Date;
  forgotPasswordAttempts?: number;
  save: Mock<() => Promise<void>>;
};

const NOW = new Date('2026-07-14T10:00:00.000Z');
const USER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');
const SESSION_ID = `ses_${'a'.repeat(36)}`;

const hashMock = bcrypt.hash as unknown as MockedFunction<HashFunction>;

const compareMock =
  bcrypt.compare as unknown as MockedFunction<CompareFunction>;

const createQuery = <T>(value: T): QueryMock<T> => {
  const query = {} as QueryMock<T>;

  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() => Promise.resolve(value));

  return query;
};

/*
 * Một số method hiện tại await trực tiếp kết quả của select(),
 * không gọi exec().
 */
const createSelectedPromise = <T>(value: T) => ({
  select: jest.fn(() => Promise.resolve(value)),
});

const createUser = (overrides: Partial<UserFixture> = {}): UserFixture => ({
  _id: USER_ID,
  publicId: 'usr_WG3FwmJfh6',
  username: 'Akuy66',
  fullname: 'Khoa',
  phone: '0778194676',
  email: 'test@example.com',
  password: 'stored-password-hash',
  avatar: 'https://example.com/avatar.jpg',
  avatarId: DEFAULT_AVATAR_ID,
  streakCount: 5,
  status: 'active',
  isDeleted: false,
  notificationSettings: {
    enabled: true,
    follow: true,
    reaction: false,
    recap: true,
  },
  refreshToken: 'legacy-refresh-token-hash',
  failedLoginAttempts: 0,
  failedLoginWindowStartedAt: null,
  lockedUntil: null,
  forgotPasswordAttempts: 0,
  save: jest.fn(() => Promise.resolve()),
  ...overrides,
});

const createContext = () => {
  const transactionSession = {} as ClientSession;

  const connection = {
    transaction: jest.fn(
      (operation: (session: ClientSession) => Promise<unknown>) =>
        operation(transactionSession),
    ),
  };

  const userModel: UserModelMock = {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn(),
    create: jest.fn(() => Promise.resolve(createUser())),
  };

  const mailService = {
    sendOtpEmail: jest.fn<(email: string, otp: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };

  const authSessionService = {
    createSession: jest.fn<AuthSessionService['createSession']>(),
    rotateRefreshToken: jest.fn<AuthSessionService['rotateRefreshToken']>(),
    revokeCurrentSession: jest.fn<AuthSessionService['revokeCurrentSession']>(),
    revokeAllSessions: jest.fn<AuthSessionService['revokeAllSessions']>(() =>
      Promise.resolve(0),
    ),
  };

  authSessionService.createSession.mockResolvedValue({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
  });

  const service = new AuthService(
    connection as unknown as Connection,
    userModel as unknown as Model<User>,
    mailService as unknown as MailService,
    authSessionService as unknown as AuthSessionService,
  );

  return {
    service,
    connection,
    transactionSession,
    userModel,
    mailService,
    authSessionService,
  };
};

const createUpdateQuery = (matchedCount: number) => ({
  exec: jest.fn(() =>
    Promise.resolve({
      acknowledged: true,
      matchedCount,
      modifiedCount: matchedCount,
      upsertedCount: 0,
      upsertedId: null,
    }),
  ),
});

describe('AuthService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    jest.clearAllMocks();

    hashMock.mockReset();
    compareMock.mockReset();

    hashMock.mockImplementation((value) =>
      Promise.resolve(`hashed:${String(value)}`),
    );
    compareMock.mockResolvedValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getCurrentUser', () => {
    it('queries the exact active user and returns the public contract', async () => {
      const user = createUser();
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery(user));

      const result = await service.getCurrentUser(user._id.toString());

      expect(userModel.findOne).toHaveBeenCalledWith({
        _id: user._id.toString(),
        isDeleted: false,
        status: 'active',
      });

      expect(result).toStrictEqual({
        id: 'usr_WG3FwmJfh6',
        publicId: 'usr_WG3FwmJfh6',
        username: 'Akuy66',
        fullname: 'Khoa',
        email: 'test@example.com',
        phone: '0778194676',
        avatar: 'https://example.com/avatar.jpg',
        hasCustomAvatar: false,
        streakCount: 5,
        status: 'active',
        notificationSettings: {
          enabled: true,
          follow: true,
          reaction: false,
          recap: true,
        },
      });
    });

    it('rejects when the active user does not exist', async () => {
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery(null));

      await expect(
        service.getCurrentUser(USER_ID.toString()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('register', () => {
    it('normalizes fields and stores only the password hash', async () => {
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery(null));

      const result = await service.register({
        username: '  test_user  ',
        fullname: '  Test User  ',
        phone: ' 0900000000 ',
        email: ' TEST@EXAMPLE.COM ',
        password: 'Password@123',
      });

      expect(result).toStrictEqual({
        success: true,
        message: 'Đăng ký thành công!',
      });

      expect(hashMock).toHaveBeenCalledWith('Password@123', 12);

      expect(userModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'test_user',
          fullname: 'Test User',
          phone: '0900000000',
          email: 'test@example.com',
          password: 'hashed:Password@123',
          publicId: expect.any(String),
        }),
      );
    });

    it('rejects a duplicate email before hashing password', async () => {
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(
        createQuery({
          username: 'another_user',
          email: 'test@example.com',
          phone: '0900000001',
        }),
      );

      await expect(
        service.register({
          username: 'test_user',
          fullname: 'Test User',
          phone: '0900000000',
          email: 'TEST@EXAMPLE.COM',
          password: 'Password@123',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(hashMock).not.toHaveBeenCalled();
      expect(userModel.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('runs bcrypt with a dummy hash for an unknown email', async () => {
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery(null));

      await expect(
        service.login(
          {
            email: ' UNKNOWN@EXAMPLE.COM ',
            password: 'WrongPassword@1',
          },
          {},
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(userModel.findOne).toHaveBeenCalledWith({
        email: 'unknown@example.com',
        isDeleted: false,
      });
      expect(compareMock).toHaveBeenCalledTimes(1);
      expect(userModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('returns 429 while the account lock is active', async () => {
      const user = createUser({
        lockedUntil: new Date(NOW.getTime() + 60_000),
      });
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery(user));
      compareMock.mockResolvedValue(true);

      const error = await service
        .login(
          {
            email: user.email,
            password: 'Password@123',
          },
          {},
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect(userModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('records a failed login attempt for a wrong password', async () => {
      const user = createUser();
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createQuery(user));
      userModel.findOneAndUpdate.mockReturnValue(
        createQuery({
          ...user,
          lockedUntil: null,
        }),
      );
      compareMock.mockResolvedValue(false);

      await expect(
        service.login(
          {
            email: user.email,
            password: 'WrongPassword@1',
          },
          {},
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(userModel.findOneAndUpdate).toHaveBeenCalled();
    });

    it('creates a session and resets login failure metadata', async () => {
      const user = createUser();
      const authenticatedUser = createUser();
      const { service, userModel, authSessionService, transactionSession } =
        createContext();
      const metadata = {
        userAgent: 'Mozilla/5.0 Chrome/126 Windows',
      };

      userModel.findOne.mockReturnValue(createQuery(user));
      userModel.findOneAndUpdate.mockReturnValue(
        createQuery(authenticatedUser),
      );

      compareMock.mockResolvedValue(true);

      const result = await service.login(
        {
          email: user.email,
          password: 'Password@123',
        },
        metadata,
      );

      expect(result).toStrictEqual({
        message: 'Đăng nhập thành công',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        user: {
          id: user.publicId,
          publicId: user.publicId,
          username: user.username,
          fullname: user.fullname,
          email: user.email,
          phone: user.phone,
          avatar: user.avatar,
          hasCustomAvatar: false,
          streakCount: user.streakCount,
          status: 'active',
          notificationSettings: user.notificationSettings,
        },
      });

      expect(userModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: user._id,
          password: user.password,
          isDeleted: false,
          status: 'active',
        }),
        expect.any(Object),
        expect.objectContaining({
          session: transactionSession,
          returnDocument: 'after',
          runValidators: true,
        }),
      );

      expect(authSessionService.createSession).toHaveBeenCalledWith(
        authenticatedUser,
        metadata,
        transactionSession,
      );
    });
  });

  describe('forgotPassword', () => {
    it('returns the same generic contract for an unknown email', async () => {
      const { service, userModel, mailService } = createContext();

      userModel.findOne.mockReturnValue(createSelectedPromise(null));

      const result = await service.forgotPassword({
        email: 'unknown@example.com',
      });

      expect(result).toStrictEqual({
        success: true,
        message: 'Nếu email hợp lệ, mã OTP sẽ được gửi đến địa chỉ đã đăng ký.',
      });
      expect(hashMock).toHaveBeenCalledTimes(1);
      expect(mailService.sendOtpEmail).not.toHaveBeenCalled();
    });

    it('stores a hashed OTP and sends only the plain OTP', async () => {
      const user = createUser({
        forgotPasswordExpiry: undefined,
      });
      const { service, userModel, mailService } = createContext();

      userModel.findOne.mockReturnValue(createSelectedPromise(user));

      await service.forgotPassword({
        email: user.email,
      });

      expect(user.forgotPasswordOtp).toMatch(/^hashed:\d{6}$/);
      expect(user.forgotPasswordAttempts).toBe(0);
      expect(user.save).toHaveBeenCalledTimes(1);

      expect(mailService.sendOtpEmail).toHaveBeenCalledWith(
        user.email,
        expect.stringMatching(/^\d{6}$/),
      );
    });

    it('does not send another OTP during cooldown', async () => {
      const user = createUser({
        forgotPasswordExpiry: new Date(NOW.getTime() + 150_000),
      });
      const { service, userModel, mailService } = createContext();

      userModel.findOne.mockReturnValue(createSelectedPromise(user));

      await service.forgotPassword({
        email: user.email,
      });

      expect(mailService.sendOtpEmail).not.toHaveBeenCalled();
      expect(user.save).not.toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    it('rejects an expired OTP without comparing hashes', async () => {
      const user = createUser({
        forgotPasswordOtp: 'otp-hash',
        forgotPasswordExpiry: new Date(NOW.getTime() - 1),
      });
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createSelectedPromise(user));

      await expect(
        service.verifyOtp({
          email: user.email,
          otp: '123456',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(compareMock).not.toHaveBeenCalled();
    });

    it('increments the failed OTP attempt count', async () => {
      const user = createUser({
        forgotPasswordOtp: 'otp-hash',
        forgotPasswordExpiry: new Date(NOW.getTime() + 60_000),
        forgotPasswordAttempts: 2,
      });
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createSelectedPromise(user));
      compareMock.mockResolvedValue(false);

      await expect(
        service.verifyOtp({
          email: user.email,
          otp: '123456',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(user.forgotPasswordAttempts).toBe(3);
      expect(user.save).toHaveBeenCalledTimes(1);
    });

    it('clears an OTP lifecycle after reaching the attempt limit', async () => {
      const user = createUser({
        forgotPasswordOtp: 'otp-hash',
        forgotPasswordExpiry: new Date(NOW.getTime() + 60_000),
        forgotPasswordAttempts: 5,
      });
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createSelectedPromise(user));

      await expect(
        service.verifyOtp({
          email: user.email,
          otp: '123456',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(user.forgotPasswordOtp).toBeUndefined();
      expect(user.forgotPasswordExpiry).toBeUndefined();
      expect(user.forgotPasswordAttempts).toBe(0);
      expect(user.save).toHaveBeenCalledTimes(1);
    });

    it('accepts a valid unexpired OTP', async () => {
      const user = createUser({
        forgotPasswordOtp: 'otp-hash',
        forgotPasswordExpiry: new Date(NOW.getTime() + 60_000),
      });
      const { service, userModel } = createContext();

      userModel.findOne.mockReturnValue(createSelectedPromise(user));
      compareMock.mockResolvedValue(true);

      await expect(
        service.verifyOtp({
          email: user.email,
          otp: '123456',
        }),
      ).resolves.toStrictEqual({
        success: true,
        message: 'OTP hợp lệ',
      });
    });
  });

  describe('resetPassword', () => {
    it('increments attempts when the OTP is invalid', async () => {
      const user = createUser({
        forgotPasswordOtp: 'otp-hash',
        forgotPasswordExpiry: new Date(NOW.getTime() + 60_000),
      });
      const { service, userModel, connection, authSessionService } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery(user));
      compareMock.mockResolvedValue(false);

      await expect(
        service.resetPassword({
          email: user.email,
          otp: '123456',
          newPassword: 'NewPassword@123',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(user.forgotPasswordAttempts).toBe(1);
      expect(user.save).toHaveBeenCalledTimes(1);
      expect(connection.transaction).not.toHaveBeenCalled();
      expect(authSessionService.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('does not consume OTP when the new password matches current password', async () => {
      const user = createUser({
        forgotPasswordOtp: 'otp-hash',
        forgotPasswordExpiry: new Date(NOW.getTime() + 60_000),
      });
      const { service, userModel, connection, authSessionService } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery(user));
      compareMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      await expect(
        service.resetPassword({
          email: user.email,
          otp: '123456',
          newPassword: 'CurrentPassword@1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(user.forgotPasswordOtp).toBe('otp-hash');
      expect(user.save).not.toHaveBeenCalled();
      expect(connection.transaction).not.toHaveBeenCalled();
      expect(authSessionService.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('does not revoke sessions when OTP CAS loses the race', async () => {
      const user = createUser({
        forgotPasswordOtp: 'otp-hash',
        forgotPasswordExpiry: new Date(NOW.getTime() + 60_000),
      });

      const { service, userModel, authSessionService } = createContext();

      userModel.findOne.mockReturnValue(createQuery(user));

      userModel.updateOne.mockReturnValue(createUpdateQuery(0));

      compareMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(
        service.resetPassword({
          email: user.email,
          otp: '123456',
          newPassword: 'NewPassword@123',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(authSessionService.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('updates password and revokes every session atomically', async () => {
      const user = createUser({
        forgotPasswordOtp: 'otp-hash',
        forgotPasswordExpiry: new Date(NOW.getTime() + 60_000),
        forgotPasswordAttempts: 2,
        failedLoginAttempts: 4,
        failedLoginWindowStartedAt: NOW,
        lockedUntil: new Date(NOW.getTime() + 60_000),
        refreshToken: 'old-refresh-hash',
      });

      const {
        service,
        userModel,
        connection,
        transactionSession,
        authSessionService,
      } = createContext();

      userModel.findOne.mockReturnValue(createQuery(user));

      userModel.updateOne.mockReturnValue(createUpdateQuery(1));

      compareMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(
        service.resetPassword({
          email: user.email,
          otp: '123456',
          newPassword: 'NewPassword@123',
        }),
      ).resolves.toStrictEqual({
        success: true,
        message: 'Đổi mật khẩu thành công!',
      });

      expect(connection.transaction).toHaveBeenCalledTimes(1);

      expect(user.save).not.toHaveBeenCalled();

      expect(userModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: user._id,
          password: user.password,
          forgotPasswordOtp: 'otp-hash',
          isDeleted: false,
          status: 'active',
        }),
        {
          $set: {
            password: 'hashed:NewPassword@123',
            refreshToken: null,
            forgotPasswordAttempts: 0,
            failedLoginAttempts: 0,
          },
          $unset: {
            forgotPasswordOtp: '',
            forgotPasswordExpiry: '',
            failedLoginWindowStartedAt: '',
            lockedUntil: '',
          },
        },
        {
          session: transactionSession,
          runValidators: true,
        },
      );

      expect(authSessionService.revokeAllSessions).toHaveBeenCalledWith(
        expect.any(Types.ObjectId),
        SessionRevokeReason.PASSWORD_RESET,
        transactionSession,
      );

      const [calledUserId] = authSessionService.revokeAllSessions.mock.calls[0];

      expect(calledUserId.toString()).toBe(user._id.toString());
    });
  });

  describe('changePassword', () => {
    it('rejects mismatched confirmation before querying MongoDB', async () => {
      const { service, userModel } = createContext();

      await expect(
        service.changePassword('invalid-id', {
          currentPassword: 'CurrentPassword@1',
          newPassword: 'NewPassword@123',
          confirmPassword: 'DifferentPassword@123',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userModel.findOne).not.toHaveBeenCalled();
    });

    it('rejects an invalid current password', async () => {
      const user = createUser();
      const { service, userModel, connection, authSessionService } =
        createContext();

      userModel.findOne.mockReturnValue(createQuery(user));
      compareMock.mockResolvedValue(false);

      await expect(
        service.changePassword(user._id.toString(), {
          currentPassword: 'WrongPassword@1',
          newPassword: 'NewPassword@123',
          confirmPassword: 'NewPassword@123',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(user.save).not.toHaveBeenCalled();
      expect(connection.transaction).not.toHaveBeenCalled();
      expect(authSessionService.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('does not revoke sessions when password CAS loses the race', async () => {
      const user = createUser();

      const { service, userModel, authSessionService } = createContext();

      userModel.findOne.mockReturnValue(createQuery(user));
      userModel.updateOne.mockReturnValue(createUpdateQuery(0));

      compareMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(
        service.changePassword(user._id.toString(), {
          currentPassword: 'CurrentPassword@1',
          newPassword: 'NewPassword@123',
          confirmPassword: 'NewPassword@123',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(authSessionService.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('changes password and revokes every session atomically', async () => {
      const user = createUser();

      const {
        service,
        userModel,
        connection,
        transactionSession,
        authSessionService,
      } = createContext();

      userModel.findOne.mockReturnValue(createQuery(user));

      userModel.updateOne.mockReturnValue(createUpdateQuery(1));

      compareMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(
        service.changePassword(user._id.toString(), {
          currentPassword: 'CurrentPassword@1',
          newPassword: 'NewPassword@123',
          confirmPassword: 'NewPassword@123',
        }),
      ).resolves.toStrictEqual({
        success: true,
        message: 'Đổi mật khẩu thành công, vui lòng đăng nhập lại',
      });

      expect(connection.transaction).toHaveBeenCalledTimes(1);

      expect(user.save).not.toHaveBeenCalled();

      expect(userModel.updateOne).toHaveBeenCalledWith(
        {
          _id: user._id,
          password: user.password,
          isDeleted: false,
          status: 'active',
        },
        {
          $set: {
            password: 'hashed:NewPassword@123',
            refreshToken: null,
          },
        },
        {
          session: transactionSession,
          runValidators: true,
        },
      );

      expect(authSessionService.revokeAllSessions).toHaveBeenCalledWith(
        expect.any(Types.ObjectId),
        SessionRevokeReason.PASSWORD_CHANGED,
        transactionSession,
      );

      const [calledUserId] = authSessionService.revokeAllSessions.mock.calls[0];
      expect(calledUserId.toString()).toBe(user._id.toString());
    });
  });

  describe('logout', () => {
    it('revokes only the current session', async () => {
      const { service, authSessionService } = createContext();

      await expect(
        service.logout(USER_ID.toString(), SESSION_ID),
      ).resolves.toStrictEqual({
        success: true,
        message: 'Đăng xuất thành công!',
      });

      const [calledUserId, calledSessionId] =
        authSessionService.revokeCurrentSession.mock.calls[0];

      expect(calledUserId).toBeInstanceOf(Types.ObjectId);
      expect(calledUserId.toString()).toBe(USER_ID.toString());
      expect(calledSessionId).toBe(SESSION_ID);
    });

    it('rejects an invalid user id without touching sessions', async () => {
      const { service, authSessionService } = createContext();

      await expect(
        service.logout('invalid-id', SESSION_ID),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(authSessionService.revokeCurrentSession).not.toHaveBeenCalled();
    });
  });

  describe('refreshToken', () => {
    it('delegates rotation and preserves its result', async () => {
      const { service, authSessionService } = createContext();
      const tokens = {
        access_token: 'next-access-token',
        refresh_token: 'next-refresh-token',
      };

      authSessionService.rotateRefreshToken.mockResolvedValue(tokens);

      await expect(
        service.refreshToken('current-refresh-token'),
      ).resolves.toStrictEqual(tokens);

      expect(authSessionService.rotateRefreshToken).toHaveBeenCalledWith(
        'current-refresh-token',
      );
    });

    it('does not rewrite errors from the session service', async () => {
      const { service, authSessionService } = createContext();
      const databaseError = new Error('database unavailable');

      authSessionService.rotateRefreshToken.mockRejectedValue(databaseError);

      await expect(service.refreshToken('current-refresh-token')).rejects.toBe(
        databaseError,
      );
    });
  });
});
