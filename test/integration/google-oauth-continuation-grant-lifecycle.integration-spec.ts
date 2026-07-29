import { createHash, randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { type Connection, createConnection, type Model, Types } from 'mongoose';

import {
  GoogleOAuthContinuationGrant,
  GoogleOAuthContinuationGrantPurpose,
  GoogleOAuthContinuationGrantSchema,
} from '../../src/modules/auth/schemas/google-oauth-continuation-grant.schema';
import { GoogleOAuthContinuationGrantService } from '../../src/modules/auth/services/google-oauth-continuation-grant.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';

const DATABASE_PREFIX = 'betta_goauth_gl_';

const MAX_DATABASE_NAME_BYTES = 38;

const databaseName =
  `${DATABASE_PREFIX}${process.pid}_` +
  randomUUID().replace(/-/gu, '').slice(0, 8);

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

jest.setTimeout(120_000);

describe('Google OAuth continuation grant lifecycle MongoDB integration', () => {
  let connection: Connection;
  let grantModel: Model<GoogleOAuthContinuationGrant>;
  let service: GoogleOAuthContinuationGrantService;

  const issueRegistrationGrant = () =>
    service.issueRegistrationGrant({
      providerAccountId: 'registration-google-subject',
      email: ' USER@EXAMPLE.COM ',
      fullname: 'OAuth User',
      avatar: null,
    });

  const consumeRegistrationGrant = (rawGrant: string) =>
    connection.transaction(async (session) =>
      service.consumeRegistrationGrant(rawGrant, session),
    );

  beforeAll(async () => {
    const uri = process.env[URI_ENV];

    if (!uri) {
      throw new Error(`${URI_ENV} chưa được cấu hình`);
    }

    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }

    if (
      !databaseName.startsWith(DATABASE_PREFIX) ||
      Buffer.byteLength(databaseName, 'utf8') > MAX_DATABASE_NAME_BYTES
    ) {
      throw new Error('Tên integration database không an toàn');
    }

    connection = await createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    }).asPromise();

    grantModel = connection.model<GoogleOAuthContinuationGrant>(
      'GoogleOAuthContinuationGrantLifecycleIntegration',
      GoogleOAuthContinuationGrantSchema.clone(),
    );

    await grantModel.syncIndexes();

    const configService = {
      get: jest.fn((key: string): string | undefined =>
        key === 'GOOGLE_OAUTH_CONTINUATION_GRANT_TTL_SECONDS'
          ? '600'
          : undefined,
      ),
    } as unknown as ConfigService;

    service = new GoogleOAuthContinuationGrantService(
      grantModel,
      configService,
    );
  });

  beforeEach(async () => {
    await grantModel.deleteMany({});
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }

    try {
      if (
        !connection.name.startsWith(DATABASE_PREFIX) ||
        Buffer.byteLength(connection.name, 'utf8') > MAX_DATABASE_NAME_BYTES
      ) {
        throw new Error(
          `Từ chối xóa database không an toàn: ${connection.name}`,
        );
      }

      await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });

  it('issues a grant without persisting the raw token', async () => {
    const issued = await issueRegistrationGrant();

    expect(issued.rawGrant).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const stored = await grantModel
      .findOne({
        grantHash: digest(issued.rawGrant),
      })
      .select('+grantHash +purpose +email +providerAccountId')
      .lean()
      .exec();

    expect(stored).toMatchObject({
      grantHash: digest(issued.rawGrant),
      purpose: GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
      email: 'user@example.com',
      providerAccountId: 'registration-google-subject',
      consumedAt: null,
    });

    expect(JSON.stringify(stored)).not.toContain(issued.rawGrant);
  });

  it('allows exactly one successful consume', async () => {
    const issued = await issueRegistrationGrant();

    await expect(consumeRegistrationGrant(issued.rawGrant)).resolves.toEqual({
      providerAccountId: 'registration-google-subject',
      email: 'user@example.com',
      fullname: 'OAuth User',
      avatar: null,
    });

    await expect(
      consumeRegistrationGrant(issued.rawGrant),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const stored = await grantModel
      .findOne({
        grantHash: digest(issued.rawGrant),
      })
      .lean()
      .exec();

    expect(stored?.consumedAt).toBeInstanceOf(Date);
  });

  it('rejects an expired grant before TTL cleanup', async () => {
    const rawGrant = 'e'.repeat(43);

    await grantModel.create({
      grantHash: digest(rawGrant),
      purpose: GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
      providerAccountId: 'expired-google-subject',
      email: 'expired@example.com',
      targetUserId: null,
      fullname: null,
      avatar: null,
      expiresAt: new Date(Date.now() - 60_000),
      consumedAt: null,
    });

    await expect(consumeRegistrationGrant(rawGrant)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not consume a grant for a wrong purpose or account', async () => {
    const targetUserId = new Types.ObjectId();

    const issued = await service.issueLinkGrant({
      providerAccountId: 'link-google-subject',
      email: 'link@example.com',
      targetUserId,
    });

    await expect(
      consumeRegistrationGrant(issued.rawGrant),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      connection.transaction(async (session) =>
        service.consumeLinkGrant(
          issued.rawGrant,
          new Types.ObjectId(),
          session,
        ),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const stored = await grantModel
      .findOne({
        grantHash: digest(issued.rawGrant),
      })
      .lean()
      .exec();

    expect(stored?.consumedAt).toBeNull();
  });

  it('rolls back consumedAt when the caller transaction fails', async () => {
    const issued = await issueRegistrationGrant();

    const rollbackError = new Error('force rollback');

    await expect(
      connection.transaction(async (session) => {
        await service.consumeRegistrationGrant(issued.rawGrant, session);

        throw rollbackError;
      }),
    ).rejects.toBe(rollbackError);

    const stored = await grantModel
      .findOne({
        grantHash: digest(issued.rawGrant),
      })
      .lean()
      .exec();

    expect(stored?.consumedAt).toBeNull();
  });

  it('rolls back issuance when the caller transaction fails', async () => {
    let rawGrant: string | null = null;

    const rollbackError = new Error('force issue rollback');

    await expect(
      connection.transaction(async (session) => {
        const issued = await service.issueRegistrationGrant(
          {
            providerAccountId: 'rollback-google-subject',
            email: 'rollback@example.com',
            fullname: null,
            avatar: null,
          },
          session,
        );

        rawGrant = issued.rawGrant;

        throw rollbackError;
      }),
    ).rejects.toBe(rollbackError);

    if (!rawGrant) {
      throw new Error('Test grant was not issued');
    }

    await expect(
      grantModel.countDocuments({
        grantHash: digest(rawGrant),
      }),
    ).resolves.toBe(0);
  });

  it('allows only one concurrent transaction to consume the grant', async () => {
    const issued = await issueRegistrationGrant();

    /*
     * Mỗi operation dùng connection.transaction riêng,
     * do đó MongoDB cấp ClientSession độc lập.
     */
    const results = await Promise.allSettled([
      consumeRegistrationGrant(issued.rawGrant),
      consumeRegistrationGrant(issued.rawGrant),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');

    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejectedResult = rejected[0];

    if (rejectedResult.status !== 'rejected') {
      throw new Error('Expected rejected consume');
    }

    expect(rejectedResult.reason).toBeInstanceOf(UnauthorizedException);
  });
});
