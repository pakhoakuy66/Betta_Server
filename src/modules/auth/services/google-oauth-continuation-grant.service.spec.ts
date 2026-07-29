import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, jest } from '@jest/globals';
import { type ClientSession, type Model, Types } from 'mongoose';

import {
  GoogleOAuthContinuationGrant,
  GoogleOAuthContinuationGrantPurpose,
} from '../schemas/google-oauth-continuation-grant.schema';
import { GoogleOAuthContinuationGrantService } from './google-oauth-continuation-grant.service';
import { GoogleOAuthContinuationGrantRejectedException } from '../exceptions/google-oauth-continuation-grant-rejected.exception';

type StoredGrant = {
  providerAccountId: string;
  email: string;
  targetUserId: Types.ObjectId | null;
  fullname: string | null;
  avatar: string | null;
};

type QueryMock = {
  select: jest.Mock<(fields: string) => QueryMock>;
  lean: jest.Mock<() => QueryMock>;
  exec: jest.Mock<() => Promise<StoredGrant | null>>;
};

type ModelMocks = {
  insertMany: jest.Mock<
    (
      documents: Array<Record<string, unknown>>,
      options: Record<string, unknown>,
    ) => Promise<unknown[]>
  >;
  findOneAndUpdate: jest.Mock<
    (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => QueryMock
  >;
};

const createSessionMock = (active = true): ClientSession =>
  ({
    inTransaction: jest.fn(() => active),
  }) as unknown as ClientSession;

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

const createContext = (ttlSeconds = '600') => {
  const query = {} as QueryMock;

  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(() => Promise.resolve(null));

  const modelMocks: ModelMocks = {
    insertMany: jest.fn(() => Promise.resolve([])),
    findOneAndUpdate: jest.fn(() => query),
  };

  const configService = {
    get: jest.fn((key: string) =>
      key === 'GOOGLE_OAUTH_CONTINUATION_GRANT_TTL_SECONDS'
        ? ttlSeconds
        : undefined,
    ),
  } as unknown as ConfigService;

  const service = new GoogleOAuthContinuationGrantService(
    modelMocks as unknown as Model<GoogleOAuthContinuationGrant>,
    configService,
  );

  return {
    service,
    modelMocks,
    query,
  };
};

describe('GoogleOAuthContinuationGrantService', () => {
  it.each(['119', '901', '600.5', 'invalid'])(
    'rejects invalid continuation TTL: %s',
    (ttl) => {
      expect(() => createContext(ttl)).toThrow(
        'GOOGLE_OAUTH_CONTINUATION_GRANT_TTL_SECONDS phải là số nguyên từ 120 đến 900',
      );
    },
  );

  it('stores only the hash of an issued grant', async () => {
    const { service, modelMocks } = createContext();

    const result = await service.issueRegistrationGrant({
      providerAccountId: 'google-subject',
      email: ' USER@EXAMPLE.COM ',
      fullname: 'User',
      avatar: null,
    });

    expect(result.rawGrant).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const documents = modelMocks.insertMany.mock.calls[0][0];

    expect(documents[0]).toMatchObject({
      grantHash: digest(result.rawGrant),
      purpose: GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
      providerAccountId: 'google-subject',
      email: 'user@example.com',
      targetUserId: null,
      consumedAt: null,
    });

    expect(JSON.stringify(documents[0])).not.toContain(result.rawGrant);
  });

  it('rejects consume outside an active transaction', async () => {
    const { service, modelMocks } = createContext();

    await expect(
      service.consumeRegistrationGrant(
        'a'.repeat(43),
        createSessionMock(false),
      ),
    ).rejects.toThrow('An active MongoDB transaction is required');

    expect(modelMocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects an invalid authenticated user id as a programming error', async () => {
    const { service, modelMocks } = createContext();

    await expect(
      service.consumeLinkGrant(
        'a'.repeat(43),
        'invalid' as unknown as Types.ObjectId,
        createSessionMock(),
      ),
    ).rejects.toBeInstanceOf(TypeError);

    expect(modelMocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects malformed raw grants without querying MongoDB', async () => {
    const { service, modelMocks } = createContext();

    await expect(
      service.consumeRegistrationGrant('invalid-token', createSessionMock()),
    ).rejects.toBeInstanceOf(GoogleOAuthContinuationGrantRejectedException);

    expect(modelMocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('binds link consume to the authenticated user in the atomic filter', async () => {
    const { service, modelMocks, query } = createContext();

    const targetUserId = new Types.ObjectId();

    query.exec.mockResolvedValue({
      providerAccountId: 'google-subject',
      email: 'user@example.com',
      targetUserId,
      fullname: null,
      avatar: null,
    });

    await expect(
      service.consumeLinkGrant(
        'a'.repeat(43),
        targetUserId,
        createSessionMock(),
      ),
    ).resolves.toEqual({
      providerAccountId: 'google-subject',
      email: 'user@example.com',
      targetUserId,
    });

    expect(modelMocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        grantHash: digest('a'.repeat(43)),
        purpose: GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
        targetUserId,
        consumedAt: null,
        expiresAt: {
          $gt: expect.any(Date),
        },
      }),
      {
        $set: {
          consumedAt: expect.any(Date),
        },
      },
      expect.objectContaining({
        returnDocument: 'after',
        session: expect.any(Object),
      }),
    );
  });

  it('rejects issuance with a non-transactional session', async () => {
    const { service, modelMocks } = createContext();

    await expect(
      service.issueRegistrationGrant(
        {
          providerAccountId: 'google-subject',
          email: 'user@example.com',
          fullname: null,
          avatar: null,
        },
        createSessionMock(false),
      ),
    ).rejects.toThrow('An active MongoDB transaction is required');

    expect(modelMocks.insertMany).not.toHaveBeenCalled();
  });

  it('retries one duplicate collision outside a transaction', async () => {
    const { service, modelMocks } = createContext();

    modelMocks.insertMany
      .mockRejectedValueOnce({ code: 11000 })
      .mockResolvedValueOnce([]);

    await expect(
      service.issueRegistrationGrant({
        providerAccountId: 'google-subject',
        email: 'user@example.com',
        fullname: null,
        avatar: null,
      }),
    ).resolves.toEqual({
      rawGrant: expect.any(String),
      expiresAt: expect.any(Date),
    });

    expect(modelMocks.insertMany).toHaveBeenCalledTimes(2);
  });

  it('does not retry duplicate key inside a transaction', async () => {
    const { service, modelMocks } = createContext();

    const duplicateError = {
      code: 11000,
    };

    modelMocks.insertMany.mockRejectedValueOnce(duplicateError);

    await expect(
      service.issueRegistrationGrant(
        {
          providerAccountId: 'google-subject',
          email: 'user@example.com',
          fullname: null,
          avatar: null,
        },
        createSessionMock(),
      ),
    ).rejects.toBe(duplicateError);

    expect(modelMocks.insertMany).toHaveBeenCalledTimes(1);
  });
});
