import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { createConnection, type Connection, type Model } from 'mongoose';
import { AccessSupportSecretsConfig } from '../../src/modules/reports/config/access-support-secrets.config';
import { AccessSupportChallengeRequiredException } from '../../src/modules/reports/exceptions/access-support-challenge-required.exception';
import {
  AccessSupportDedupe,
  AccessSupportDedupeSchema,
} from '../../src/modules/reports/schemas/access-support-dedupe.schema';
import {
  ReportRateLimit,
  ReportRateLimitSchema,
} from '../../src/modules/reports/schemas/report-rate-limit.schema';
import {
  SystemReport,
  SystemReportSchema,
} from '../../src/modules/reports/schemas/system-report.schema';
import { AccessSupportCryptoService } from '../../src/modules/reports/services/access-support-crypto.service';
import { AccessSupportDedupeService } from '../../src/modules/reports/services/access-support-dedupe.service';
import { AccessSupportRateLimitService } from '../../src/modules/reports/services/access-support-rate-limit.service';
import { AccessSupportService } from '../../src/modules/reports/services/access-support.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const databaseName = `betta_access_support_it_${process.pid}_${randomBytes(4).toString('hex')}`;
const keyring = (byte: number, id: string) =>
  JSON.stringify({
    current: { id, keyBase64: Buffer.alloc(32, byte).toString('base64') },
  });

jest.setTimeout(90_000);

describe('Public access-support MongoDB integration', () => {
  let connection: Connection;
  let systemReports: Model<SystemReport>;
  let dedupeModel: Model<AccessSupportDedupe>;
  let service: AccessSupportService;
  let rateLimit: AccessSupportRateLimitService;
  let dedupe: AccessSupportDedupeService;
  let crypto: AccessSupportCryptoService;

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chưa được cấu hình`);
    if (process.env[CONFIRM_ENV] !== 'YES') {
      throw new Error(`${CONFIRM_ENV}=YES là bắt buộc`);
    }
    if ([process.env.DATABASE_URL, process.env.MONGODB_URI].includes(uri)) {
      throw new Error('Integration URI không được trùng runtime URI');
    }
    connection = createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 15_000,
    });
    await connection.asPromise();
    systemReports = connection.model(SystemReport.name, SystemReportSchema);
    const counters = connection.model(
      ReportRateLimit.name,
      ReportRateLimitSchema,
    );
    dedupeModel = connection.model(
      AccessSupportDedupe.name,
      AccessSupportDedupeSchema,
    );
    await Promise.all([
      systemReports.createIndexes(),
      counters.createIndexes(),
      dedupeModel.createIndexes(),
    ]);

    const secrets = new AccessSupportSecretsConfig(
      new ConfigService({
        ACCESS_SUPPORT_ENCRYPTION_KEYRING_JSON: keyring(21, 'enc-it-v1'),
        ACCESS_SUPPORT_HMAC_KEYRING_JSON: keyring(22, 'hmac-it-v1'),
      }),
    );
    crypto = new AccessSupportCryptoService(secrets);
    rateLimit = new AccessSupportRateLimitService(counters, crypto);
    dedupe = new AccessSupportDedupeService(dedupeModel);
    service = new AccessSupportService(
      systemReports,
      crypto,
      rateLimit,
      dedupe,
    );
  });

  afterAll(async () => {
    if (!connection) return;
    await connection.dropDatabase();
    await connection.close();
  });

  it('stores encrypted public intake and returns one id for a duplicate', async () => {
    const dto = {
      category: 'LOGIN_PROBLEM' as const,
      contactEmail: 'person@example.com',
      accountEmailOrUsername: 'person',
      description: 'Tôi không thể đăng nhập vào tài khoản từ sáng nay.',
    };
    const first = await service.submit(dto, '127.0.0.1');
    const replay = await service.submit(dto, '127.0.0.1');
    expect(replay).toEqual(first);

    const document = await connection
      .collection('system_reports')
      .findOne({ publicId: first.reportPublicId });
    expect(document).toMatchObject({
      reporterId: null,
      source: 'AUTH_PUBLIC',
      reportType: 'ACCOUNT_ACCESS',
      category: 'LOGIN_PROBLEM',
      evidenceImages: [],
    });
    expect(document?.encryptedContactEmail).toMatch(/^asenc\.v1\./);
    expect(JSON.stringify(document)).not.toContain('person@example.com');
    expect(await connection.collection('users').countDocuments()).toBe(0);
    expect(await connection.collection('system_reports').countDocuments()).toBe(
      1,
    );
  });

  it('deduplicates the same business request across correlation ids', async () => {
    const businessRequest = {
      category: 'GOOGLE_SIGN_IN_PROBLEM' as const,
      contactEmail: 'semantic-dedupe@example.com',
      accountEmailOrUsername: 'semantic-dedupe-user',
      description: 'Tôi cần hỗ trợ đăng nhập Google cho tài khoản thử nghiệm.',
    };

    const first = await service.submit(
      { ...businessRequest, correlationId: 'corr-semantic-0001' },
      '127.0.0.41',
    );
    const replay = await service.submit(
      { ...businessRequest, correlationId: 'corr-semantic-0002' },
      '127.0.0.41',
    );

    expect(replay).toEqual(first);
    expect(
      await connection.collection('system_reports').countDocuments({
        publicId: first.reportPublicId,
      }),
    ).toBe(1);
    expect(
      await connection
        .collection('system_reports')
        .findOne(
          { publicId: first.reportPublicId },
          { projection: { correlationId: 1 } },
        ),
    ).toMatchObject({ correlationId: 'corr-semantic-0001' });
  });

  it('deduplicates concurrent durable intake across a fixed-window boundary', async () => {
    const fingerprint = crypto.hmac('dedupe', 'boundary-fingerprint');
    const boundary = Date.parse('2026-08-21T10:15:00.000Z');
    const claims = await Promise.all([
      dedupe.claim(fingerprint, new Date(boundary - 1)),
      dedupe.claim(fingerprint, new Date(boundary + 1)),
    ]);
    expect(new Set(claims.map((claim) => claim.reportPublicId)).size).toBe(1);
    expect(
      await connection
        .collection('access_support_dedupes')
        .countDocuments({ fingerprintHmac: fingerprint }),
    ).toBe(1);

    const noRateLimit = {
      consumeIp: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      consumeContact: jest
        .fn<() => Promise<void>>()
        .mockResolvedValue(undefined),
    } as unknown as AccessSupportRateLimitService;
    const concurrentService = new AccessSupportService(
      systemReports,
      crypto,
      noRateLimit,
      dedupe,
    );
    const dto = {
      category: 'ACCOUNT_RESTRICTED' as const,
      contactEmail: 'boundary@example.com',
      description: 'Tôi cần hỗ trợ truy cập tài khoản đang bị hạn chế.',
    };
    const responses = await Promise.all([
      concurrentService.submit(dto, '127.0.0.31'),
      concurrentService.submit(dto, '127.0.0.32'),
    ]);

    expect(new Set(responses.map((item) => item.reportPublicId)).size).toBe(1);
    expect(
      await connection.collection('system_reports').countDocuments({
        publicId: responses[0].reportPublicId,
      }),
    ).toBe(1);
  });
  it('requires challenge from the third request and rejects secrets', async () => {
    await expect(
      service.submit(
        {
          category: 'OTHER_ACCOUNT_ACCESS_ISSUE',
          contactEmail: 'another@example.com',
          description: 'Tôi cần hỗ trợ truy cập tài khoản trên thiết bị mới.',
        },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(AccessSupportChallengeRequiredException);

    await expect(
      service.submit(
        {
          category: 'LOGIN_PROBLEM',
          contactEmail: 'safe@example.com',
          description: 'Không đăng nhập được, password: do-not-store-this',
        },
        '127.0.0.2',
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(
      JSON.stringify(
        await connection.collection('system_reports').find({}).toArray(),
      ),
    ).not.toContain('do-not-store-this');
  });

  it('survives concurrent first-use counter upserts', async () => {
    await expect(
      Promise.all([
        rateLimit.consumeIp('127.0.0.9', 'same-fingerprint'),
        rateLimit.consumeIp('127.0.0.9', 'same-fingerprint'),
      ]),
    ).resolves.toEqual([undefined, undefined]);
  });
});
