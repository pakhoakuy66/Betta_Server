import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import type { AccessTokenPayload } from '../interfaces/auth-session.interface';
import { AuthSessionService } from '../services/auth-session.service';
import { User } from '../../users/schemas/user.schema';
import { JwtStrategy } from './jwt.strategy';

type JwtUserLookup = {
  _id: Types.ObjectId;
  email: string;
  username: string;
};

type QueryMock<T> = {
  select: Mock<(fields: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

const USER_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');
const SESSION_ID = `ses_${'a'.repeat(36)}`;
const ACCESS_SECRET = 'unit-access-secret-'.padEnd(48, 'a');

const createQuery = <T>(value: T): QueryMock<T> => {
  const query = {} as QueryMock<T>;
  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() => Promise.resolve(value));
  return query;
};

const createContext = (secret: unknown = ACCESS_SECRET) => {
  const configService = {
    get: jest.fn<(key: string) => unknown>(() => secret),
  };
  const userModel = {
    findOne: jest.fn(),
  };
  const authSessionService = {
    isSessionActive: jest.fn<AuthSessionService['isSessionActive']>(),
  };

  const strategy = new JwtStrategy(
    configService as unknown as ConfigService,
    userModel as unknown as Model<User>,
    authSessionService as unknown as AuthSessionService,
  );

  return { strategy, userModel, authSessionService };
};

const validPayload: AccessTokenPayload = {
  tokenUse: 'access',
  sub: USER_ID.toString(),
  sid: SESSION_ID,
  email: 'token@example.com',
  username: 'token_user',
};

describe('JwtStrategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['missing', null],
    ['wrong type', 123],
    ['too short', 'short-secret'],
  ])('rejects a %s JWT secret', (_label, secret) => {
    expect(() => createContext(secret)).toThrow();
  });

  it.each([
    [{ ...validPayload, tokenUse: 'refresh' }],
    [{ ...validPayload, sub: 'invalid-id' }],
    [{ ...validPayload, sid: 'invalid-session' }],
  ])('rejects an invalid access payload', async (payload) => {
    const { strategy, userModel, authSessionService } = createContext();

    await expect(
      strategy.validate(payload as AccessTokenPayload),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(userModel.findOne).not.toHaveBeenCalled();
    expect(authSessionService.isSessionActive).not.toHaveBeenCalled();
  });

  it('rejects when either the user or session is inactive', async () => {
    const { strategy, userModel, authSessionService } = createContext();
    userModel.findOne.mockReturnValue(createQuery(null));
    authSessionService.isSessionActive.mockResolvedValue(true);

    await expect(strategy.validate(validPayload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('returns the exact internal request context', async () => {
    const { strategy, userModel, authSessionService } = createContext();
    userModel.findOne.mockReturnValue(
      createQuery<JwtUserLookup>({
        _id: USER_ID,
        email: 'database@example.com',
        username: 'database_user',
      }),
    );
    authSessionService.isSessionActive.mockResolvedValue(true);

    await expect(strategy.validate(validPayload)).resolves.toStrictEqual({
      _id: USER_ID.toString(),
      id: USER_ID.toString(),
      email: 'database@example.com',
      username: 'database_user',
      sessionId: SESSION_ID,
    });

    expect(userModel.findOne).toHaveBeenCalledWith({
      _id: USER_ID,
      isDeleted: false,
      status: 'active',
    });
    expect(authSessionService.isSessionActive).toHaveBeenCalledWith(
      USER_ID,
      SESSION_ID,
    );
  });

  it('does not rewrite database errors as unauthorized', async () => {
    const databaseError = new Error('database unavailable');
    const { strategy, userModel, authSessionService } = createContext();
    const query = createQuery<JwtUserLookup | null>(null);
    query.exec.mockRejectedValue(databaseError);
    userModel.findOne.mockReturnValue(query);
    authSessionService.isSessionActive.mockResolvedValue(true);

    await expect(strategy.validate(validPayload)).rejects.toBe(databaseError);
  });
});
