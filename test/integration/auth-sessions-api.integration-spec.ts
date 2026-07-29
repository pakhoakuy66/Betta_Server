import {
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import type { Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Connection, createConnection, type Model, Types } from 'mongoose';
import request from 'supertest';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter';
import { ApiResponseInterceptor } from '../../src/common/interceptors/api-response.interceptor';
import {
  ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ALGORITHM,
  AUTH_JWT_ISSUER,
} from '../../src/modules/auth/constants/auth-token.constants';
import { AuthSessionsController } from '../../src/modules/auth/controllers/auth-sessions.controller';
import type { AccessTokenPayload } from '../../src/modules/auth/interfaces/auth-session.interface';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditReasonCode,
} from '../../src/modules/auth/interfaces/auth-audit.interface';
import {
  AuthSession,
  AuthSessionSchema,
  SessionRevokeReason,
} from '../../src/modules/auth/schemas/auth-session.schema';
import {
  AuthSessionService,
  type AuthTokenPair,
} from '../../src/modules/auth/services/auth-session.service';
import { AuthAuditService } from '../../src/modules/auth/services/auth-audit.service';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';
import {
  AuthAuditEvent,
  AuthAuditEventSchema,
} from '../../src/modules/auth/schemas/auth-audit-event.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const REQUIRED_CONFIRMATION = 'YES';
const DATABASE_PREFIX = 'betta_auth_sessions_api_it_';
const MAX_DATABASE_NAME_BYTES = 48;
const databaseName = `${DATABASE_PREFIX}${process.pid}`;

const ACCESS_SECRET = 'session-api-access-secret-'.padEnd(48, 'a');
const REFRESH_SECRET = 'session-api-refresh-secret-'.padEnd(48, 'b');

const configService = {
  get: (key: string): unknown =>
    ({
      JWT_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_SECONDS: 604800,
      REFRESH_TOKEN_HASH_ROUNDS: 8,
      AUTH_AUDIT_RETENTION_DAYS: 180,
    })[key],
} as ConfigService;

type SessionFixture = {
  id: string;
  tokens: AuthTokenPair;
};

type PublicSessionBody = {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

type SessionListBody = {
  success: true;
  data: PublicSessionBody[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

type ErrorBody = {
  success: false;
  statusCode: number;
  message: string | string[];
  path: string;
};

const parseBody = <T>(text: string): T => JSON.parse(text) as T;

type AuditInsertManyMethod = (...args: unknown[]) => Promise<unknown>;

jest.setTimeout(120_000);

if (Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES) {
  throw new Error('Tên integration database vượt quá giới hạn an toàn');
}

if (!databaseName.startsWith(DATABASE_PREFIX)) {
  throw new Error('Tên integration database không an toàn');
}

describe('Auth sessions HTTP API MongoDB integration', () => {
  let connection: Connection;
  let userModel: Model<User>;
  let sessionModel: Model<AuthSession>;
  let auditModel: Model<AuthAuditEvent>;
  let jwtService: JwtService;
  let sessionService: AuthSessionService;
  let app: INestApplication;
  let httpServer: Server;
  let sequence = 0;

  const createAuditInsertSpy = () =>
    jest.spyOn(
      auditModel as unknown as {
        insertMany: AuditInsertManyMethod;
      },
      'insertMany',
    );

  const createAuditFailure = (): Error =>
    Object.assign(new Error('Audit persistence failed'), {
      name: 'MongoServerSelectionError',
    });

  const createUser = async (label: string): Promise<User> => {
    sequence += 1;
    const suffix = `${process.pid}_${sequence}`;

    return userModel.create({
      publicId: `usr_session_api_${suffix}`,
      username: `session_api_${suffix}`,
      fullname: `Session API ${label}`,
      phone: `093${String(sequence).padStart(7, '0')}`,
      email: `session_api_${suffix}@example.com`,
      password: 'integration-only-password-hash',
      status: 'active',
      isDeleted: false,
    });
  };

  const readAccessPayload = (token: string): AccessTokenPayload =>
    jwtService.verify<AccessTokenPayload>(token, {
      secret: ACCESS_SECRET,
      issuer: AUTH_JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      algorithms: [AUTH_JWT_ALGORITHM],
    });

  const createSession = async (
    user: User,
    userAgent: string,
  ): Promise<SessionFixture> => {
    const tokens = await sessionService.createSession(user, { userAgent });

    return {
      id: readAccessPayload(tokens.access_token).sid,
      tokens,
    };
  };

  const getSessions = (accessToken: string, query = '') =>
    request(httpServer)
      .get(`/api/v1/auth/sessions${query}`)
      .set('Authorization', `Bearer ${accessToken}`);

  beforeAll(async () => {
    const uri = process.env[URI_ENV];

    if (!uri) {
      throw new Error(
        `${URI_ENV} chưa được cấu hình. ` +
          'Không dùng database developer/production cho integration test.',
      );
    }

    if (process.env[CONFIRMATION_ENV] !== REQUIRED_CONFIRMATION) {
      throw new Error(`${CONFIRMATION_ENV} phải bằng ${REQUIRED_CONFIRMATION}`);
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    if (!connection.name.startsWith(DATABASE_PREFIX)) {
      await connection.close();
      throw new Error(`Từ chối chạy trên database: ${connection.name}`);
    }

    userModel = connection.model<User>(User.name, UserSchema);
    sessionModel = connection.model<AuthSession>(
      AuthSession.name,
      AuthSessionSchema,
    );

    auditModel = connection.model<AuthAuditEvent>(
      AuthAuditEvent.name,
      AuthAuditEventSchema,
    );

    await Promise.all([
      userModel.syncIndexes(),
      sessionModel.syncIndexes(),
      auditModel.syncIndexes(),
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [AuthSessionsController],
      providers: [
        JwtService,
        AuthSessionService,
        JwtStrategy,
        AuthAuditService,
        { provide: ConfigService, useValue: configService },
        { provide: getModelToken(User.name), useValue: userModel },
        { provide: getModelToken(AuthSession.name), useValue: sessionModel },
        {
          provide: getConnectionToken(),
          useValue: connection,
        },
        {
          provide: getModelToken(AuthAuditEvent.name),
          useValue: auditModel,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    app.useGlobalInterceptors(new ApiResponseInterceptor(app.get(Reflector)));
    await app.init();

    jwtService = app.get(JwtService);
    sessionService = app.get(AuthSessionService);
    httpServer = app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await Promise.all([
      auditModel.collection.deleteMany({}),
      sessionModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!connection) return;

    if (!connection.name.startsWith(DATABASE_PREFIX)) {
      await connection.close();
      throw new Error(`Từ chối xóa database: ${connection.name}`);
    }

    try {
      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('requires an access token and validates pagination input', async () => {
    const user = await createUser('validation');
    const current = await createSession(user, 'Chrome/126 Windows');

    const unauthorized = await request(httpServer).get('/api/v1/auth/sessions');
    expect(unauthorized.status).toBe(401);
    expect(parseBody<ErrorBody>(unauthorized.text)).toEqual(
      expect.objectContaining({
        success: false,
        statusCode: 401,
        path: '/api/v1/auth/sessions',
      }),
    );

    const refreshAsBearer = await getSessions(current.tokens.refresh_token);
    expect(refreshAsBearer.status).toBe(401);

    for (const query of [
      '?page=abc',
      '?page=0',
      '?page=1.5',
      '?limit=0',
      '?limit=51',
      '?limit=abc',
      '?unexpected=true',
    ]) {
      const response = await getSessions(current.tokens.access_token, query);
      const body = parseBody<ErrorBody>(response.text);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.statusCode).toBe(400);
    }
  });

  it('lists only active owner sessions with a stable public contract', async () => {
    const owner = await createUser('owner');
    const otherUser = await createUser('other');
    const sessions = await Promise.all([
      createSession(owner, 'Chrome/126 Windows'),
      createSession(owner, 'Firefox/127 Linux'),
      createSession(owner, 'Safari/17 Mac OS X'),
      createSession(owner, 'Chrome/126 Android'),
    ]);
    await createSession(otherUser, 'Unrelated browser');

    const response = await getSessions(sessions[0].tokens.access_token);
    const body = parseBody<SessionListBody>(response.text);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 4,
      totalPages: 1,
    });
    expect(body.data).toHaveLength(4);
    expect(body.data[0]).toEqual(
      expect.objectContaining({ id: sessions[0].id, isCurrent: true }),
    );

    for (const item of body.data) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'createdAt',
          'deviceLabel',
          'expiresAt',
          'id',
          'isCurrent',
          'lastUsedAt',
        ].sort(),
      );
    }

    const pagedIds: string[] = [];

    for (let page = 1; page <= 5; page += 1) {
      const pageResponse = await getSessions(
        sessions[0].tokens.access_token,
        `?page=${page}&limit=1`,
      );
      const pageBody = parseBody<SessionListBody>(pageResponse.text);

      expect(pageResponse.status).toBe(200);
      expect(pageBody.pagination.total).toBe(4);
      expect(pageBody.pagination.totalPages).toBe(4);

      if (page <= 4) {
        expect(pageBody.data).toHaveLength(1);
        pagedIds.push(pageBody.data[0].id);
      } else {
        expect(pageBody.data).toEqual([]);
      }
    }

    expect(pagedIds[0]).toBe(sessions[0].id);
    expect(new Set(pagedIds).size).toBe(4);
  });

  it('rejects current-session and cross-user revocation', async () => {
    const owner = await createUser('revoke-owner');
    const otherUser = await createUser('revoke-other');
    const current = await createSession(owner, 'Chrome Windows');
    const foreign = await createSession(otherUser, 'Firefox Linux');

    const currentResponse = await request(httpServer)
      .delete(`/api/v1/auth/sessions/${current.id}`)
      .set('Authorization', `Bearer ${current.tokens.access_token}`);
    expect(currentResponse.status).toBe(400);
    expect(parseBody<ErrorBody>(currentResponse.text).message).toBe(
      'Hãy sử dụng chức năng đăng xuất để đóng phiên hiện tại',
    );

    const foreignResponse = await request(httpServer)
      .delete(`/api/v1/auth/sessions/${foreign.id}`)
      .set('Authorization', `Bearer ${current.tokens.access_token}`);
    expect(foreignResponse.status).toBe(404);

    expect((await getSessions(current.tokens.access_token)).status).toBe(200);
    expect((await getSessions(foreign.tokens.access_token)).status).toBe(200);
  });

  it('allows only one concurrent revocation winner', async () => {
    const user = await createUser('concurrent');
    const current = await createSession(user, 'Chrome Windows');
    const target = await createSession(user, 'Firefox Linux');

    const revoke = () =>
      request(httpServer)
        .delete(`/api/v1/auth/sessions/${target.id}`)
        .set('Authorization', `Bearer ${current.tokens.access_token}`);

    const responses = await Promise.all([revoke(), revoke()]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 404]);

    const storedTarget = await sessionModel
      .findOne({ publicId: target.id })
      .lean()
      .exec();
    expect(storedTarget?.revokedAt).toBeInstanceOf(Date);
    expect(storedTarget?.revokeReason).toBe(
      SessionRevokeReason.SESSION_REVOKED,
    );
    expect((await getSessions(target.tokens.access_token)).status).toBe(401);
    await expect(
      sessionService.rotateRefreshToken(target.tokens.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect((await getSessions(current.tokens.access_token)).status).toBe(200);

    const userObjectId = new Types.ObjectId(String(user._id));

    const audit = await auditModel.collection.findOne({
      targetUserId: userObjectId,
      eventCode: AuthAuditEventCode.SESSION_REVOKED,
    });

    expect(audit).toEqual(
      expect.objectContaining({
        eventCode: AuthAuditEventCode.SESSION_REVOKED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.SESSION_REVOKE_REQUESTED,
        sessionPublicId: target.id,
      }),
    );

    expect(String(audit?.targetUserId)).toBe(userObjectId.toString());

    expect(String(audit?.actorUserId)).toBe(userObjectId.toString());

    expect(
      await auditModel.collection.countDocuments({
        targetUserId: userObjectId,
        eventCode: AuthAuditEventCode.SESSION_REVOKED,
      }),
    ).toBe(1);
  });

  it('rolls back session revoke when audit persistence fails', async () => {
    const user = await createUser('revoke-audit-failure');
    const current = await createSession(user, 'Chrome Windows');
    const target = await createSession(user, 'Firefox Linux');

    const insertSpy = createAuditInsertSpy();

    insertSpy.mockImplementationOnce(() =>
      Promise.reject(createAuditFailure()),
    );

    const response = await (async () => {
      try {
        return await request(httpServer)
          .delete(`/api/v1/auth/sessions/${target.id}`)
          .set('Authorization', `Bearer ${current.tokens.access_token}`);
      } finally {
        insertSpy.mockRestore();
      }
    })();

    expect(response.status).toBe(503);

    const storedTarget = await sessionModel
      .findOne({ publicId: target.id })
      .lean()
      .exec();

    expect(storedTarget?.revokedAt).toBeNull();
    expect(storedTarget?.revokeReason).toBeNull();

    expect(
      await auditModel.collection.countDocuments({
        eventCode: AuthAuditEventCode.SESSION_REVOKED,
      }),
    ).toBe(0);
  });

  it('logs out all active sessions without overwriting prior reasons', async () => {
    const user = await createUser('logout-all');
    const current = await createSession(user, 'Chrome Windows');
    const previouslyRevoked = await createSession(user, 'Firefox Linux');
    const activeOther = await createSession(user, 'Safari Mac OS X');

    const expired = await createSession(user, 'Edge Windows');

    await sessionModel.updateOne(
      { publicId: expired.id },
      {
        $set: {
          expiresAt: new Date(Date.now() - 60_000),
        },
      },
    );

    const revokeResponse = await request(httpServer)
      .delete(`/api/v1/auth/sessions/${previouslyRevoked.id}`)
      .set('Authorization', `Bearer ${current.tokens.access_token}`);
    expect(revokeResponse.status).toBe(200);
    expect(parseBody<unknown>(revokeResponse.text)).toEqual({
      success: true,
      message: 'Đã đăng xuất phiên được chọn',
      data: null,
    });

    const logoutAllResponse = await request(httpServer)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${current.tokens.access_token}`);
    expect(logoutAllResponse.status).toBe(200);
    expect(parseBody<unknown>(logoutAllResponse.text)).toEqual({
      success: true,
      message: 'Đã đăng xuất khỏi tất cả thiết bị',
      data: null,
    });

    expect((await getSessions(current.tokens.access_token)).status).toBe(401);
    expect((await getSessions(activeOther.tokens.access_token)).status).toBe(
      401,
    );

    await expect(
      sessionService.rotateRefreshToken(current.tokens.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      sessionService.rotateRefreshToken(activeOther.tokens.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const storedSessions = await sessionModel
      .find({ userId: new Types.ObjectId(String(user._id)) })
      .lean()
      .exec();
    const reasons = new Map(
      storedSessions.map((session) => [session.publicId, session.revokeReason]),
    );

    expect(reasons.get(previouslyRevoked.id)).toBe(
      SessionRevokeReason.SESSION_REVOKED,
    );
    expect(reasons.get(current.id)).toBe(SessionRevokeReason.LOGOUT_ALL);
    expect(reasons.get(activeOther.id)).toBe(SessionRevokeReason.LOGOUT_ALL);
    expect(reasons.get(expired.id)).toBeNull();

    const expiredStored = storedSessions.find(
      (session) => session.publicId === expired.id,
    );

    expect(expiredStored?.revokedAt).toBeNull();

    const userObjectId = new Types.ObjectId(String(user._id));

    const logoutAudit = await auditModel.collection.findOne({
      targetUserId: userObjectId,
      eventCode: AuthAuditEventCode.SESSIONS_REVOKED_ALL,
    });

    expect(logoutAudit).toEqual(
      expect.objectContaining({
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.LOGOUT_ALL_REQUESTED,
        metadata: expect.objectContaining({
          affectedSessionCount: 2,
        }),
      }),
    );

    expect(logoutAudit).not.toHaveProperty('sessionPublicId');
    expect(
      await auditModel.collection.countDocuments({
        targetUserId: userObjectId,
        eventCode: AuthAuditEventCode.SESSIONS_REVOKED_ALL,
      }),
    ).toBe(1);
  });

  it('rolls back logout-all when audit persistence fails', async () => {
    const user = await createUser('logout-all-audit-failure');
    const current = await createSession(user, 'Chrome Windows');
    const other = await createSession(user, 'Firefox Linux');

    const insertSpy = createAuditInsertSpy();

    insertSpy.mockImplementationOnce(() =>
      Promise.reject(createAuditFailure()),
    );

    const response = await (async () => {
      try {
        return await request(httpServer)
          .post('/api/v1/auth/logout-all')
          .set('Authorization', `Bearer ${current.tokens.access_token}`);
      } finally {
        insertSpy.mockRestore();
      }
    })();

    expect(response.status).toBe(503);

    const sessions = await sessionModel
      .find({
        publicId: {
          $in: [current.id, other.id],
        },
      })
      .lean()
      .exec();

    expect(sessions).toHaveLength(2);
    expect(
      sessions.every(
        (session) =>
          session.revokedAt === null && session.revokeReason === null,
      ),
    ).toBe(true);

    expect(
      await auditModel.collection.countDocuments({
        eventCode: AuthAuditEventCode.SESSIONS_REVOKED_ALL,
      }),
    ).toBe(0);
  });

  it('writes one audit for concurrent logout-all', async () => {
    const user = await createUser('logout-all-concurrent');

    await Promise.all([
      createSession(user, 'Chrome Windows'),
      createSession(user, 'Firefox Linux'),
    ]);

    const userId = String(user._id);

    const results = await Promise.all([
      sessionService.logoutAllSessions(userId),
      sessionService.logoutAllSessions(userId),
    ]);

    expect(results.sort((a, b) => a - b)).toEqual([0, 2]);

    const userObjectId = new Types.ObjectId(userId);

    expect(
      await auditModel.collection.countDocuments({
        targetUserId: userObjectId,
        eventCode: AuthAuditEventCode.SESSIONS_REVOKED_ALL,
      }),
    ).toBe(1);

    const audit = await auditModel.collection.findOne({
      targetUserId: userObjectId,
      eventCode: AuthAuditEventCode.SESSIONS_REVOKED_ALL,
    });

    expect(audit?.metadata).toEqual(
      expect.objectContaining({
        affectedSessionCount: 2,
      }),
    );
  });
});
