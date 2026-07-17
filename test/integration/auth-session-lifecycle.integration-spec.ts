import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { Connection, createConnection, Model, Types } from 'mongoose';
import { AuthSessionService } from '../../src/modules/auth/services/auth-session.service';
import {
  AuthSession,
  AuthSessionSchema,
  SessionRevokeReason,
} from '../../src/modules/auth/schemas/auth-session.schema';
import { User, UserSchema } from '../../src/modules/users/schemas/user.schema';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRMATION_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const REQUIRED_CONFIRMATION = 'YES';
const DATABASE_PREFIX = 'betta_auth_session_it_';
const databaseName = `${DATABASE_PREFIX}${process.pid}`;

const ACCESS_SECRET = 'integration-access-secret-'.padEnd(48, 'a');
const REFRESH_SECRET = 'integration-refresh-secret-'.padEnd(48, 'b');

const configService = {
  get: (key: string): unknown =>
    ({
      JWT_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_SECONDS: 604800,
      REFRESH_TOKEN_HASH_ROUNDS: 8,
    })[key],
} as ConfigService;

describe('Auth session lifecycle MongoDB integration', () => {
  let connection: Connection;
  let sessionModel: Model<AuthSession>;
  let userModel: Model<User>;
  let service: AuthSessionService;

  const createUser = async (suffix: string): Promise<User> =>
    userModel.create({
      publicId: `usr_session_it_${suffix}`,
      username: `session_it_${suffix}`,
      fullname: `Session Integration ${suffix}`,
      phone: `092${suffix.padStart(7, '0').slice(-7)}`,
      email: `session_it_${suffix}@example.com`,
      password: 'integration-only-password-hash',
      status: 'active',
      isDeleted: false,
    });

  beforeAll(async () => {
    const uri = process.env[URI_ENV];

    if (!uri) {
      throw new Error(`${URI_ENV} chưa được cấu hình`);
    }

    if (process.env[CONFIRMATION_ENV] !== REQUIRED_CONFIRMATION) {
      throw new Error(`${CONFIRMATION_ENV} phải bằng ${REQUIRED_CONFIRMATION}`);
    }

    if (!databaseName.startsWith(DATABASE_PREFIX)) {
      throw new Error('Tên integration database không an toàn');
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    if (!connection.name.startsWith(DATABASE_PREFIX)) {
      await connection.close();
      throw new Error(`Từ chối database: ${connection.name}`);
    }

    sessionModel = connection.model<AuthSession>(
      AuthSession.name,
      AuthSessionSchema,
    );
    userModel = connection.model<User>(User.name, UserSchema);

    await Promise.all([sessionModel.syncIndexes(), userModel.syncIndexes()]);

    service = new AuthSessionService(
      sessionModel,
      userModel,
      new JwtService(),
      configService,
    );
  });

  beforeEach(async () => {
    await Promise.all([sessionModel.deleteMany({}), userModel.deleteMany({})]);
  });

  afterAll(async () => {
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

  it('creates independent sessions without exposing refresh hashes', async () => {
    const user = await createUser('independent');

    const first = await service.createSession(user, {
      userAgent: 'Chrome Windows raw user agent',
    });
    const second = await service.createSession(user, {
      userAgent: 'Safari iPhone raw user agent',
    });

    const sessions = await sessionModel
      .find({ userId: user._id })
      .sort({ lastUsedAt: -1 })
      .lean()
      .exec();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].publicId).not.toBe(sessions[1].publicId);
    expect(sessions[0].tokenFamily).not.toBe(sessions[1].tokenFamily);
    expect(sessions[0]).not.toHaveProperty('refreshTokenHash');
    expect(JSON.stringify(sessions)).not.toContain(first.refresh_token);
    expect(JSON.stringify(sessions)).not.toContain(second.refresh_token);
    expect(JSON.stringify(sessions)).not.toContain('raw user agent');
  });

  it('allows one concurrent rotation winner without revoking it', async () => {
    const user = await createUser('concurrent');
    const initial = await service.createSession(user, {});

    const results = await Promise.allSettled([
      service.rotateRefreshToken(initial.refresh_token),
      service.rotateRefreshToken(initial.refresh_token),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const session = await sessionModel
      .findOne({ userId: user._id })
      .select('+refreshTokenHash')
      .exec();

    expect(session).not.toBeNull();
    expect(session?.tokenVersion).toBe(1);
    expect(session?.revokedAt).toBeNull();

    const winner = results.find((result) => result.status === 'fulfilled');

    if (!winner || winner.status !== 'fulfilled') {
      throw new Error('Không tìm thấy concurrent rotation winner');
    }

    await expect(
      service.rotateRefreshToken(winner.value.refresh_token),
    ).resolves.toEqual(
      expect.objectContaining({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
      }),
    );
  });

  it('revokes the family when an old token is replayed after rotation', async () => {
    const user = await createUser('replay');
    const initial = await service.createSession(user, {});

    await service.rotateRefreshToken(initial.refresh_token);

    await expect(
      service.rotateRefreshToken(initial.refresh_token),
    ).rejects.toBeDefined();

    const session = await sessionModel.findOne({ userId: user._id }).exec();

    expect(session?.revokedAt).toBeInstanceOf(Date);
    expect(session?.revokeReason).toBe(SessionRevokeReason.REFRESH_REPLAY);
  });

  it('rejects an expired session before the TTL monitor deletes it', async () => {
    const user = await createUser('expired');
    const tokens = await service.createSession(user, {});

    await sessionModel.updateOne(
      { userId: user._id },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    expect(await sessionModel.exists({ userId: user._id })).toBeTruthy();
    await expect(
      service.rotateRefreshToken(tokens.refresh_token),
    ).rejects.toBeDefined();
  });

  it('revokes only the requested user sessions', async () => {
    const firstUser = await createUser('revoke_a');
    const secondUser = await createUser('revoke_b');

    await service.createSession(firstUser, {});
    await service.createSession(firstUser, {});
    await service.createSession(secondUser, {});

    const modified = await service.revokeAllSessions(
      new Types.ObjectId(String(firstUser._id)),
      SessionRevokeReason.LOGOUT_ALL,
    );

    expect(modified).toBe(2);
    expect(
      await sessionModel.countDocuments({
        userId: firstUser._id,
        revokedAt: { $ne: null },
      }),
    ).toBe(2);
    expect(
      await sessionModel.countDocuments({
        userId: secondUser._id,
        revokedAt: null,
      }),
    ).toBe(1);
  });
});
