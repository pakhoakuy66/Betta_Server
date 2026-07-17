import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { type ClientSession, Model, Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';
import {
  AuthSession,
  SessionRevokeReason,
} from '../schemas/auth-session.schema';
import { AuthSessionService } from './auth-session.service';

const ACCESS_SECRET = 'a'.repeat(48);
const REFRESH_SECRET = 'b'.repeat(48);
const NOW = new Date('2026-07-15T12:00:00.000Z');

type QueryStub<T> = {
  select: jest.Mock<(selection: string) => QueryStub<T>>;
  exec: jest.Mock<() => Promise<T>>;
};

type SessionCreateInput = {
  userId: Types.ObjectId;
  publicId: string;
  tokenFamily: string;
  tokenVersion: number;
  refreshTokenHash: string;
  deviceLabel: string;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: SessionRevokeReason | null;
};

type SessionCreateFunction = (
  input: SessionCreateInput | SessionCreateInput[],
  options?: {
    session?: ClientSession;
  },
) => Promise<unknown>;

type SessionCreateMock = jest.Mock<SessionCreateFunction>;

const getCreatedSessionInput = (
  createMock: SessionCreateMock,
  callIndex = 0,
): SessionCreateInput => {
  const input = createMock.mock.calls[callIndex]?.[0] as
    | SessionCreateInput
    | SessionCreateInput[]
    | undefined;

  const document = Array.isArray(input) ? input[0] : input;

  if (!document) {
    throw new Error('Không tìm thấy auth session fixture');
  }

  return document;
};

const queryStub = <T>(result: T): QueryStub<T> => {
  const stub = {
    select: jest.fn<(selection: string) => QueryStub<T>>(),
    exec: jest.fn<() => Promise<T>>(() => Promise.resolve(result)),
  };

  stub.select.mockReturnValue(stub);
  return stub;
};

const rejectedQueryStub = <T>(error: Error): QueryStub<T> => {
  const stub = queryStub<T>(undefined as T);
  stub.exec.mockRejectedValue(error);
  return stub;
};

const createConfig = (
  overrides: Record<string, unknown> = {},
): ConfigService => {
  const values: Record<string, unknown> = {
    JWT_SECRET: ACCESS_SECRET,
    JWT_REFRESH_SECRET: REFRESH_SECRET,
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 604800,
    REFRESH_TOKEN_HASH_ROUNDS: 8,
    ...overrides,
  };

  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
};

const createContext = (config = createConfig()) => {
  const sessionModel = {
    create: jest.fn<SessionCreateFunction>((input) => Promise.resolve(input)),
    findOne: jest.fn<(filter: unknown) => QueryStub<AuthSession | null>>(),
    findOneAndUpdate:
      jest.fn<
        (
          filter: unknown,
          update: unknown,
          options: unknown,
        ) => QueryStub<AuthSession | null>
      >(),
    updateOne: jest.fn<(filter: unknown, update: unknown) => Promise<unknown>>(
      () => Promise.resolve({ modifiedCount: 1 }),
    ),
    updateMany: jest.fn<
      (
        filter: unknown,
        update: unknown,
        options?: {
          session?: ClientSession;
        },
      ) => Promise<{
        modifiedCount: number;
      }>
    >(() =>
      Promise.resolve({
        modifiedCount: 2,
      }),
    ),
    exists: jest.fn<(filter: unknown) => QueryStub<unknown>>(),
  };

  const userModel = {
    findById: jest.fn<(id: Types.ObjectId) => QueryStub<User | null>>(),
  };

  const jwtService = new JwtService();
  const service = new AuthSessionService(
    sessionModel as unknown as Model<AuthSession>,
    userModel as unknown as Model<User>,
    jwtService,
    config,
  );

  return { service, sessionModel, userModel, jwtService };
};

const createUser = () => ({
  _id: new Types.ObjectId(),
  email: 'session@example.com',
  username: 'session_user',
  status: 'active',
  isDeleted: false,
});

const createStoredSession = (input: SessionCreateInput): AuthSession =>
  ({
    _id: new Types.ObjectId(),
    ...input,
  }) as unknown as AuthSession;

describe('AuthSessionService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('validates secrets and numeric configuration at startup', () => {
    expect(() =>
      createContext(createConfig({ JWT_REFRESH_SECRET: 'short' })),
    ).toThrow('JWT_REFRESH_SECRET phải có tối thiểu 32 ký tự');

    expect(() =>
      createContext(createConfig({ JWT_REFRESH_SECRET: ACCESS_SECRET })),
    ).toThrow('JWT_SECRET và JWT_REFRESH_SECRET không được giống nhau');

    expect(() =>
      createContext(createConfig({ JWT_ACCESS_TTL_SECONDS: 59 })),
    ).toThrow('JWT_ACCESS_TTL_SECONDS phải là số nguyên từ 60 đến 3600');
  });

  it('creates independent token purposes and stores only normalized data', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, sessionModel, jwtService } = createContext();
    const user = createUser();
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/120.0';

    const tokens = await service.createSession(user as User, { userAgent });
    const stored = getCreatedSessionInput(sessionModel.create);

    const accessPayload = jwtService.verify<Record<string, unknown>>(
      tokens.access_token,
      {
        secret: ACCESS_SECRET,
        issuer: 'betta',
        audience: 'betta-api',
        algorithms: ['HS256'],
      },
    );
    const refreshPayload = jwtService.verify<Record<string, unknown>>(
      tokens.refresh_token,
      {
        secret: REFRESH_SECRET,
        issuer: 'betta',
        audience: 'betta-refresh',
        algorithms: ['HS256'],
      },
    );

    expect(accessPayload.tokenUse).toBe('access');
    expect(refreshPayload.tokenUse).toBe('refresh');
    expect(refreshPayload.version).toBe(0);
    expect(stored.refreshTokenHash).not.toBe(tokens.refresh_token);
    expect(stored.refreshTokenHash).toMatch(/^sha256-bcrypt-v1:/);
    expect(stored.deviceLabel).toBe('Chrome trên Windows');
    expect(stored).not.toHaveProperty('userAgent');
    expect(stored.expiresAt).toEqual(new Date(NOW.getTime() + 604800 * 1000));
  });

  it('creates different session and family identifiers', async () => {
    const { service, sessionModel } = createContext();
    const user = createUser();

    await service.createSession(user as User, {});
    await service.createSession(user as User, {});

    const first = getCreatedSessionInput(sessionModel.create, 0);
    const second = getCreatedSessionInput(sessionModel.create, 1);

    expect(first.publicId).not.toBe(second.publicId);
    expect(first.tokenFamily).not.toBe(second.tokenFamily);
  });

  it('rotates atomically and does not inherit registered JWT claims', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, sessionModel, userModel, jwtService } = createContext();
    const user = createUser();
    const initialTokens = await service.createSession(user as User, {});
    const input = getCreatedSessionInput(sessionModel.create);
    const storedSession = createStoredSession(input);

    sessionModel.findOne.mockReturnValue(queryStub(storedSession));
    userModel.findById.mockReturnValue(queryStub(user as User));
    sessionModel.findOneAndUpdate.mockReturnValue(queryStub(storedSession));

    jest.setSystemTime(new Date(NOW.getTime() + 60_000));
    const rotated = await service.rotateRefreshToken(
      initialTokens.refresh_token,
    );
    const update = sessionModel.findOneAndUpdate.mock.calls[0][1] as {
      $set: {
        tokenVersion: number;
        refreshTokenHash: string;
        lastUsedAt: Date;
        expiresAt: Date;
      };
    };
    const payload = jwtService.verify<Record<string, unknown>>(
      rotated.refresh_token,
      {
        secret: REFRESH_SECRET,
        issuer: 'betta',
        audience: 'betta-refresh',
        algorithms: ['HS256'],
      },
    );

    expect(payload.version).toBe(1);
    expect(payload.sid).toBe(input.publicId);
    expect(payload.family).toBe(input.tokenFamily);
    expect(update.$set.tokenVersion).toBe(1);
    expect(update.$set.refreshTokenHash).not.toBe(input.refreshTokenHash);
    expect(update.$set.lastUsedAt).toEqual(new Date(Date.now()));
    expect(update.$set.expiresAt).toEqual(new Date(Date.now() + 604800 * 1000));
  });

  it('does not revoke the winning session when CAS loses', async () => {
    const { service, sessionModel, userModel } = createContext();
    const user = createUser();
    const initialTokens = await service.createSession(user as User, {});
    const storedSession = createStoredSession(
      getCreatedSessionInput(sessionModel.create),
    );

    sessionModel.findOne.mockReturnValue(queryStub(storedSession));
    userModel.findById.mockReturnValue(queryStub(user as User));
    sessionModel.findOneAndUpdate.mockReturnValue(queryStub(null));
    sessionModel.updateOne.mockClear();

    await expect(
      service.rotateRefreshToken(initialTokens.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sessionModel.updateOne).not.toHaveBeenCalled();
  });

  it('revokes a stale version as refresh replay', async () => {
    const { service, sessionModel } = createContext();
    const user = createUser();
    const initialTokens = await service.createSession(user as User, {});
    const stored = createStoredSession({
      ...getCreatedSessionInput(sessionModel.create),
      tokenVersion: 1,
    });

    sessionModel.findOne.mockReturnValue(queryStub(stored));
    sessionModel.updateOne.mockClear();

    await expect(
      service.rotateRefreshToken(initialTokens.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sessionModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        publicId: stored.publicId,
        tokenFamily: stored.tokenFamily,
      }),
      {
        $set: expect.objectContaining({
          revokeReason: SessionRevokeReason.REFRESH_REPLAY,
        }),
      },
    );
  });

  it.each([
    [true, 'active', SessionRevokeReason.ACCOUNT_DELETED],
    [false, 'banned', SessionRevokeReason.ACCOUNT_BLOCKED],
  ])(
    'revokes invalid account state deleted=%s status=%s',
    async (isDeleted, status, reason) => {
      const { service, sessionModel, userModel } = createContext();
      const user = createUser();
      const initialTokens = await service.createSession(user as User, {});
      const stored = createStoredSession(
        getCreatedSessionInput(sessionModel.create),
      );

      sessionModel.findOne.mockReturnValue(queryStub(stored));
      userModel.findById.mockReturnValue(
        queryStub({ ...user, isDeleted, status } as User),
      );
      sessionModel.updateOne.mockClear();

      await expect(
        service.rotateRefreshToken(initialTokens.refresh_token),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(sessionModel.updateOne).toHaveBeenCalledWith(expect.any(Object), {
        $set: expect.objectContaining({ revokeReason: reason }),
      });
    },
  );

  it('does not convert MongoDB failures into unauthorized errors', async () => {
    const { service, sessionModel } = createContext();
    const user = createUser();
    const initialTokens = await service.createSession(user as User, {});
    const databaseError = new Error('database unavailable');

    sessionModel.findOne.mockReturnValue(
      rejectedQueryStub<AuthSession | null>(databaseError),
    );

    await expect(
      service.rotateRefreshToken(initialTokens.refresh_token),
    ).rejects.toBe(databaseError);
  });

  it('rejects an access token at the refresh boundary', async () => {
    const { service } = createContext();
    const user = createUser();
    const tokens = await service.createSession(user as User, {});

    await expect(
      service.rotateRefreshToken(tokens.access_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes current and all sessions idempotently', async () => {
    const { service, sessionModel } = createContext();
    const userId = new Types.ObjectId();
    const sessionId = `ses_${'a'.repeat(36)}`;

    await service.revokeCurrentSession(userId, sessionId);
    const modified = await service.revokeAllSessions(
      userId,
      SessionRevokeReason.PASSWORD_CHANGED,
    );

    expect(sessionModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        publicId: sessionId,
        revokedAt: null,
      }),
      expect.any(Object),
    );
    expect(modified).toBe(2);
  });

  it('checks active, expired and malformed session identifiers', async () => {
    const { service, sessionModel } = createContext();
    const userId = new Types.ObjectId();
    const sessionId = `ses_${'b'.repeat(36)}`;

    sessionModel.exists.mockReturnValue(queryStub({ _id: userId }));
    await expect(service.isSessionActive(userId, sessionId)).resolves.toBe(
      true,
    );

    sessionModel.exists.mockReturnValue(queryStub(null));
    await expect(service.isSessionActive(userId, sessionId)).resolves.toBe(
      false,
    );
    await expect(service.isSessionActive(userId, 'bad')).resolves.toBe(false);
  });

  it('passes the transaction to session create and revoke-all', async () => {
    const { service, sessionModel } = createContext();

    const mongoSession = {} as ClientSession;

    const user = createUser();

    await service.createSession(
      user as User,
      { userAgent: 'Chrome Windows' },
      mongoSession,
    );

    expect(sessionModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          userId: expect.any(Types.ObjectId),
          publicId: expect.stringMatching(/^ses_/),
        }),
      ],
      {
        session: mongoSession,
      },
    );

    await service.revokeAllSessions(
      user._id,
      SessionRevokeReason.PASSWORD_CHANGED,
      mongoSession,
    );

    expect(sessionModel.updateMany).toHaveBeenCalledWith(
      {
        userId: user._id,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: expect.any(Date),
          revokeReason: SessionRevokeReason.PASSWORD_CHANGED,
        },
      },
      {
        session: mongoSession,
      },
    );
  });
});
