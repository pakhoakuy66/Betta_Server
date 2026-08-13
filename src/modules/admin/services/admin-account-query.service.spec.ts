import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { AdminAccountQueryService } from './admin-account-query.service';

type TestAccount = ReturnType<typeof createTestAccount>;

function createTestAccount(
  publicId: string,
  id = new Types.ObjectId(),
  createdAt = new Date('2026-08-10T00:00:00.000Z'),
): {
  _id: Types.ObjectId;
  publicId: string;
  email: string;
  username: string;
  displayName: string;
  role: AdminRole;
  status: AdminAccountStatus;
  mfaStatus: AdminMfaStatus;
  mustChangePassword: boolean;
  version: number;
  lockedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} {
  return {
    _id: id,
    publicId,
    email: `${publicId.toLowerCase()}@betta.test`,
    username: publicId.toLowerCase(),
    displayName: publicId,
    role: AdminRole.ADMIN,
    status: AdminAccountStatus.ACTIVE,
    mfaStatus: AdminMfaStatus.ACTIVE,
    mustChangePassword: false,
    version: 3,
    lockedAt: null,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

const account = (...args: Parameters<typeof createTestAccount>): TestAccount =>
  createTestAccount(...args);

const chainedQuery = (result: unknown) => {
  const query = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(result)),
  };
  query.sort.mockReturnValue(query);
  query.skip.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
};

const aggregateQuery = (result: unknown) => ({
  exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(result)),
});

describe('AdminAccountQueryService', () => {
  it('paginates deterministically and loads session summaries in one query', async () => {
    const first = account('adm_23456789ABCD');
    const second = account('adm_3456789ABCDE');
    const overflow = account('adm_456789ABCDEF');
    const findQuery = chainedQuery([first, second, overflow]);
    const sessionQuery = aggregateQuery([
      {
        _id: first._id,
        activeCount: 2,
        lastActiveAt: new Date('2026-08-10T01:00:00.000Z'),
      },
    ]);
    const accounts = {
      find: jest.fn<(filter: unknown) => unknown>(() => findQuery),
      findOne: jest.fn(),
    };
    const sessions = { aggregate: jest.fn(() => sessionQuery) };
    const service = new AdminAccountQueryService(
      accounts as never,
      sessions as never,
    );

    const result = await service.list({ page: 2, limit: 2 });

    expect(accounts.find).toHaveBeenCalledWith({});
    expect(findQuery.sort).toHaveBeenCalledWith({
      createdAt: -1,
      publicId: 1,
    });
    expect(findQuery.skip).toHaveBeenCalledWith(2);
    expect(findQuery.limit).toHaveBeenCalledWith(3);
    expect(findQuery.select).toHaveBeenCalledWith(
      expect.not.stringContaining('passwordHash'),
    );
    expect(sessions.aggregate).toHaveBeenCalledTimes(1);
    expect(result.pagination).toEqual({ page: 2, limit: 2, hasMore: true });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.sessionSummary).toEqual({
      activeCount: 2,
      lastActiveAt: '2026-08-10T01:00:00.000Z',
    });
    expect(result.items[0]?.version).toBe(3);
    expect(result.items[1]?.sessionSummary).toEqual({
      activeCount: 0,
      lastActiveAt: null,
    });
    expect(JSON.stringify(result)).not.toContain(first._id.toHexString());
  });

  it('uses only allowlisted filters and exact normalized identity search', async () => {
    const findQuery = chainedQuery([]);
    const accounts = {
      find: jest.fn<(filter: unknown) => unknown>(() => findQuery),
      findOne: jest.fn(),
    };
    const sessions = { aggregate: jest.fn() };
    const service = new AdminAccountQueryService(
      accounts as never,
      sessions as never,
    );

    await service.list({
      page: 1,
      limit: 20,
      role: AdminRole.SUPER_ADMIN,
      status: AdminAccountStatus.SOFT_DELETED,
      mfaStatus: AdminMfaStatus.RESET_REQUIRED,
      search: '  Root.Admin@BETTA.TEST  ',
    });

    expect(accounts.find).toHaveBeenCalledWith({
      role: AdminRole.SUPER_ADMIN,
      status: AdminAccountStatus.SOFT_DELETED,
      mfaStatus: AdminMfaStatus.RESET_REQUIRED,
      $or: [
        { email: 'root.admin@betta.test' },
        { username: 'root.admin@betta.test' },
      ],
    });
    expect(sessions.aggregate).not.toHaveBeenCalled();
  });

  it('returns detail for soft-deleted accounts and 404 for unknown public IDs', async () => {
    const deleted = account('adm_56789ABCDEFG');
    deleted.status = AdminAccountStatus.SOFT_DELETED;
    deleted.deletedAt = new Date('2026-08-11T00:00:00.000Z');
    const detailQuery = chainedQuery(deleted);
    const missingQuery = chainedQuery(null);
    const accounts = {
      find: jest.fn(),
      findOne: jest
        .fn()
        .mockReturnValueOnce(detailQuery)
        .mockReturnValueOnce(missingQuery),
    };
    const sessionQuery = aggregateQuery([]);
    const sessions = { aggregate: jest.fn(() => sessionQuery) };
    const service = new AdminAccountQueryService(
      accounts as never,
      sessions as never,
    );

    await expect(service.detail(deleted.publicId)).resolves.toMatchObject({
      publicId: deleted.publicId,
      status: AdminAccountStatus.SOFT_DELETED,
      deletedAt: '2026-08-11T00:00:00.000Z',
    });
    await expect(service.detail('adm_6789ABCDEFGH')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects malformed input before persistence and sanitizes Mongo outages', async () => {
    const outage = Object.assign(new Error('mongodb.internal:27017'), {
      name: 'MongoServerSelectionError',
    });
    const failedQuery = chainedQuery(null);
    failedQuery.exec.mockRejectedValue(outage);
    const accounts = {
      find: jest.fn(),
      findOne: jest.fn(() => failedQuery),
    };
    const sessions = { aggregate: jest.fn() };
    const service = new AdminAccountQueryService(
      accounts as never,
      sessions as never,
    );

    await expect(
      service.detail('507f1f77bcf86cd799439011'),
    ).rejects.toBeInstanceOf(TypeError);
    expect(accounts.findOne).not.toHaveBeenCalled();

    const result = service.detail('adm_789ABCDEFGHJ');
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({
      response: {
        message: expect.not.stringMatching(/mongodb\.internal/u),
        statusCode: 503,
      },
    });
  });
});
