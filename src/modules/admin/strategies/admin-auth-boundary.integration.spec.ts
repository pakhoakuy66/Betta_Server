import {
  Controller,
  Get,
  type INestApplication,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { AuthGuard, PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { type Mock } from 'jest-mock';
import { Types } from 'mongoose';
import request from 'supertest';
import { type App } from 'supertest/types';
import { ApiExceptionFilter } from '../../../common/filters/api-exception.filter';
import { type AuthenticatedRequest } from '../../../common/types/authenticated-request';
import {
  ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ALGORITHM,
  AUTH_JWT_ISSUER,
} from '../../auth/constants/auth-token.constants';
import { AuthSessionService } from '../../auth/services/auth-session.service';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { User } from '../../users/schemas/user.schema';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import {
  ADMIN_SECRETS,
  AdminSecretPurpose,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import { AdminRole } from '../constants/admin-account.constants';
import {
  ADMIN_ACCESS_TOKEN_AUDIENCE,
  ADMIN_ACCESS_TOKEN_ISSUER,
  ADMIN_ACCESS_TOKEN_USE,
  ADMIN_AUTHENTICATION_FAILED_MESSAGE,
  ADMIN_JWT_ALGORITHM,
} from '../constants/admin-auth-token.constants';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminAccessTokenService } from '../services/admin-access-token.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';
import { AdminJwtStrategy } from './admin-jwt.strategy';

type QueryMock<T> = {
  select: Mock<(projection: string) => QueryMock<T>>;
  lean: Mock<() => QueryMock<T>>;
  exec: Mock<() => Promise<T>>;
};

type AdminLookup = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
};

const ADMIN_ID = 'adm_23456789ABCD';
const ADMIN_OBJECT_ID = new Types.ObjectId('6a3924c4f5a540da96575f6a');
const ADMIN_SESSION_ID = `ases_${'a'.repeat(36)}`;
const ADMIN_KEY_ID = 'admin-access-v1';
const ADMIN_KEY = Buffer.alloc(32, 31);
const USER_SECRET = 'user-access-secret-'.padEnd(48, 'u');

const ACTIVE_ADMIN: AdminLookup = {
  _id: ADMIN_OBJECT_ID,
  publicId: ADMIN_ID,
  username: 'admin.qa',
  displayName: 'Admin QA',
  role: AdminRole.SUPER_ADMIN,
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
};

@Controller('test/admin-boundary')
@UseGuards(AdminJwtAuthGuard)
class TestAdminBoundaryController {
  @Get()
  getPrincipal(@Req() req: AdminAuthenticatedRequest) {
    return {
      publicId: req.user.publicId,
      role: req.user.role,
      immutable: Object.isFrozen(req.user),
    };
  }
}

@Controller('test/user-boundary')
@UseGuards(AuthGuard('jwt'))
class TestUserBoundaryController {
  @Get()
  getPrincipal(@Req() req: AuthenticatedRequest) {
    return { id: req.user.id };
  }
}

const adminSecrets = {
  current: (purpose: unknown) => {
    if (purpose !== AdminSecretPurpose.ACCESS_TOKEN_SIGNING) {
      throw new Error('unexpected purpose');
    }
    return { id: ADMIN_KEY_ID, key: ADMIN_KEY };
  },
  resolve: (purpose: unknown, keyId: unknown) => {
    if (
      purpose !== AdminSecretPurpose.ACCESS_TOKEN_SIGNING ||
      keyId !== ADMIN_KEY_ID
    ) {
      throw new Error('unknown key');
    }
    return { id: ADMIN_KEY_ID, key: ADMIN_KEY };
  },
} as unknown as AdminSecrets;

const adminPolicy = {
  session: { accessTokenTtlSeconds: 900 },
} as AdminPolicy;

describe('Admin/User Nest Passport boundary', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let accessTokenService: AdminAccessTokenService;
  let adminLookup: AdminLookup | null = ACTIVE_ADMIN;
  let adminLookupError: Error | undefined;

  const adminModel = {
    findOne: jest.fn(() => {
      const query = {} as QueryMock<AdminLookup | null>;
      query.select = jest.fn(() => query);
      query.lean = jest.fn(() => query);
      query.exec = jest.fn(() =>
        adminLookupError
          ? Promise.reject(adminLookupError)
          : Promise.resolve(adminLookup),
      );
      return query;
    }),
  };
  const userModel = { findOne: jest.fn() };
  const authSessionService = { isSessionActive: jest.fn() };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({})],
      controllers: [TestAdminBoundaryController, TestUserBoundaryController],
      providers: [
        AdminAccessTokenService,
        AdminJwtStrategy,
        AdminJwtAuthGuard,
        JwtStrategy,
        { provide: ADMIN_SECRETS, useValue: adminSecrets },
        { provide: ADMIN_POLICY, useValue: adminPolicy },
        { provide: getModelToken(AdminAccount.name), useValue: adminModel },
        { provide: getModelToken(User.name), useValue: userModel },
        { provide: AuthSessionService, useValue: authSessionService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string): unknown =>
              key === 'JWT_SECRET' ? USER_SECRET : undefined,
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    jwtService = moduleFixture.get(JwtService);
    accessTokenService = moduleFixture.get(AdminAccessTokenService);
  });

  afterEach(() => {
    adminLookup = ACTIVE_ADMIN;
    adminLookupError = undefined;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  const issueAdminToken = (): Promise<string> =>
    accessTokenService.issue({
      adminPublicId: ADMIN_ID,
      sessionPublicId: ADMIN_SESSION_ID,
      credentialVersion: 2,
      authzVersion: 3,
      permissionVersion: 4,
    });

  const signAdminLikeToken = (
    payload: Record<string, unknown>,
    options: {
      issuer?: string;
      audience?: string;
      keyid?: string;
      expiresIn?: number;
    } = {},
  ): string =>
    jwtService.sign(payload, {
      secret: ADMIN_KEY,
      algorithm: ADMIN_JWT_ALGORITHM,
      keyid: options.keyid ?? ADMIN_KEY_ID,
      issuer: options.issuer ?? ADMIN_ACCESS_TOKEN_ISSUER,
      audience: options.audience ?? ADMIN_ACCESS_TOKEN_AUDIENCE,
      subject: ADMIN_ID,
      expiresIn: options.expiresIn ?? 900,
    });

  const validAdminPayload = (): Record<string, unknown> => ({
    tokenUse: ADMIN_ACCESS_TOKEN_USE,
    sid: ADMIN_SESSION_ID,
    credentialVersion: 2,
    authzVersion: 3,
    permissionVersion: 4,
  });

  it('authenticates a valid Admin token and hydrates role from DB', async () => {
    const token = await issueAdminToken();

    const response = await request(app.getHttpServer())
      .get('/test/admin-boundary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      publicId: ADMIN_ID,
      role: AdminRole.SUPER_ADMIN,
      immutable: true,
    });
    expect(JSON.stringify(response.body)).not.toContain(
      ADMIN_OBJECT_ID.toHexString(),
    );
  });

  it('rejects a User token at the actual Admin guard', async () => {
    const userToken = jwtService.sign(
      { tokenUse: 'access', sid: `ses_${'u'.repeat(36)}` },
      {
        secret: USER_SECRET,
        algorithm: AUTH_JWT_ALGORITHM,
        issuer: AUTH_JWT_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        subject: ADMIN_OBJECT_ID.toHexString(),
        expiresIn: 900,
      },
    );

    const response = await request(app.getHttpServer())
      .get('/test/admin-boundary')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(401);

    const body = response.body as { message?: unknown };
    expect(body.message).toBe(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
  });

  it.each([
    ['missing kid', undefined],
    ['unknown kid', 'unknown-admin-key'],
  ])('normalizes %s to 401 instead of 500', async (_label, keyid) => {
    const token = jwtService.sign(validAdminPayload(), {
      secret: ADMIN_KEY,
      algorithm: ADMIN_JWT_ALGORITHM,
      ...(keyid ? { keyid } : {}),
      issuer: ADMIN_ACCESS_TOKEN_ISSUER,
      audience: ADMIN_ACCESS_TOKEN_AUDIENCE,
      subject: ADMIN_ID,
      expiresIn: 900,
    });

    const response = await request(app.getHttpServer())
      .get('/test/admin-boundary')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    const body = response.body as { message?: unknown };
    expect(body.message).toBe(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
  });

  it.each([
    [
      'wrong issuer',
      () =>
        signAdminLikeToken(validAdminPayload(), { issuer: AUTH_JWT_ISSUER }),
    ],
    [
      'wrong audience',
      () =>
        signAdminLikeToken(validAdminPayload(), {
          audience: ACCESS_TOKEN_AUDIENCE,
        }),
    ],
    [
      'wrong token use',
      () => signAdminLikeToken({ ...validAdminPayload(), tokenUse: 'access' }),
    ],
    [
      'expired token',
      () => signAdminLikeToken(validAdminPayload(), { expiresIn: -1 }),
    ],
  ])('rejects %s through Passport', async (_label, createToken) => {
    const response = await request(app.getHttpServer())
      .get('/test/admin-boundary')
      .set('Authorization', `Bearer ${createToken()}`)
      .expect(401);

    const body = response.body as { message?: unknown };
    expect(body.message).toBe(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
    expect(adminModel.findOne).not.toHaveBeenCalled();
  });

  it('preserves DB infrastructure failure as sanitized 503', async () => {
    adminLookupError = Object.assign(new Error('database unavailable'), {
      name: 'MongoServerSelectionError',
    });
    const token = await issueAdminToken();

    const response = await request(app.getHttpServer())
      .get('/test/admin-boundary')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);

    const body = response.body as { error?: unknown };
    expect(body.error).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain(ADMIN_ID);
    expect(JSON.stringify(response.body)).not.toContain(
      ADMIN_OBJECT_ID.toHexString(),
    );
  });

  it('rejects an Admin token at the actual User guard', async () => {
    const token = await issueAdminToken();

    await request(app.getHttpServer())
      .get('/test/user-boundary')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(userModel.findOne).not.toHaveBeenCalled();
    expect(authSessionService.isSessionActive).not.toHaveBeenCalled();
  });
});
