import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import {
  UserDeletionOrigin,
  UserRestrictionType,
} from '../../users/constants/user-moderation.constants';
import { USER_STATUS } from '../../users/schemas/user.schema';
import {
  AdminUserDeletionFilter,
  AdminUserLoginLockFilter,
  AdminUserRestrictionFilter,
  AdminUserSort,
} from '../constants/admin-user-query.constants';
import { AdminUserQueryService } from './admin-user-query.service';

const user = (publicId = 'usr_23456789AB', id = new Types.ObjectId()) => ({
  _id: id,
  publicId,
  username: 'managed.user',
  fullname: 'Managed User',
  email: 'managed.user@betta.test',
  phone: '0394281845',
  avatar: 'https://cdn.example/avatar.webp',
  bio: '',
  link: '',
  status: USER_STATUS.ACTIVE,
  isDeleted: false,
  deletedAt: null,
  deletionOrigin: null,
  restorableUntil: null,
  restriction: null,
  version: 2,
  lockedUntil: null,
  streakCount: 1,
  postsCount: 2,
  followersCount: 3,
  followingCount: 4,
  lastActive: new Date('2026-08-15T01:00:00.000Z'),
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-15T00:00:00.000Z'),
});

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

const countQuery = (result: number) => ({
  exec: jest.fn<() => Promise<number>>(() => Promise.resolve(result)),
});

const serviceWith = (findResult: unknown[] = []) => {
  const findQuery = chainedQuery(findResult);
  const users = {
    find: jest.fn<(filter: unknown) => unknown>(() => findQuery),
    findOne: jest.fn(),
  };
  const sessions = { aggregate: jest.fn() };
  const reports = {
    countDocuments: jest.fn<(filter: unknown) => ReturnType<typeof countQuery>>(
      () => countQuery(0),
    ),
  };
  const auditEvents = {
    countDocuments: jest.fn<(filter: unknown) => ReturnType<typeof countQuery>>(
      () => countQuery(0),
    ),
  };
  return {
    users,
    sessions,
    reports,
    auditEvents,
    findQuery,
    service: new AdminUserQueryService(
      users as never,
      sessions as never,
      reports as never,
      auditEvents as never,
    ),
  };
};

describe('AdminUserQueryService', () => {
  it('uses deterministic bounded pagination and an explicit projection', async () => {
    const fixtures = [
      user('usr_23456789AB'),
      user('usr_3456789ABC'),
      user('usr_456789ABCD'),
    ];
    const context = serviceWith(fixtures);

    const result = await context.service.list({
      page: 2,
      limit: 2,
      sort: AdminUserSort.CREATED_AT_DESC,
    });

    expect(context.findQuery.sort).toHaveBeenCalledWith({
      createdAt: -1,
      publicId: 1,
    });
    expect(context.findQuery.skip).toHaveBeenCalledWith(2);
    expect(context.findQuery.limit).toHaveBeenCalledWith(3);
    expect(context.findQuery.select).toHaveBeenCalledWith(
      expect.not.stringMatching(
        /password|refreshToken|forgotPassword|moderationMigration|authzVersion/u,
      ),
    );
    expect(result.pagination).toEqual({ page: 2, limit: 2, hasMore: true });
    expect(result.items).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(
      fixtures[0]?._id.toHexString(),
    );
  });

  it('builds only allowlisted exact filters and keeps lock separate from restriction', async () => {
    const context = serviceWith([]);

    await context.service.list({
      page: 1,
      limit: 20,
      status: USER_STATUS.ACTIVE,
      deletion: AdminUserDeletionFilter.ACTIVE,
      restriction: AdminUserRestrictionFilter.TEMPORARY_SUSPENSION,
      loginLock: AdminUserLoginLockFilter.LOCKED,
      sort: AdminUserSort.USERNAME_ASC,
      search: '  Managed.User@BETTA.TEST  ',
    });

    expect(context.users.find).toHaveBeenCalledWith({
      status: USER_STATUS.ACTIVE,
      isDeleted: false,
      'restriction.type': UserRestrictionType.TEMPORARY_SUSPENSION,
      lockedUntil: { $gt: expect.any(Date) },
      $and: [{ email: 'managed.user@betta.test' }],
    });
    expect(context.findQuery.sort).toHaveBeenCalledWith({
      username: 1,
      publicId: 1,
    });
  });

  it.each([
    ['usr_23456789AB', { publicId: 'usr_23456789AB' }],
    ['0394281845', { phone: '0394281845' }],
    ['managed.user', { username: 'managed.user' }],
  ])('normalizes exact identity search %s', async (search, expected) => {
    const context = serviceWith([]);

    await context.service.list({
      page: 1,
      limit: 20,
      sort: AdminUserSort.CREATED_AT_DESC,
      search,
    });

    expect(context.users.find).toHaveBeenCalledWith({ $and: [expected] });
  });

  it('returns deleted detail by public ID with active session summary', async () => {
    const deleted = {
      ...user(),
      isDeleted: true,
      deletionOrigin: UserDeletionOrigin.ADMIN_MODERATION,
      deletedAt: new Date('2026-08-14T00:00:00.000Z'),
    };
    const detailQuery = chainedQuery(deleted);
    const missingQuery = chainedQuery(null);
    const users = {
      find: jest.fn(),
      findOne: jest
        .fn()
        .mockReturnValueOnce(detailQuery)
        .mockReturnValueOnce(missingQuery),
    };
    const sessions = {
      aggregate: jest.fn(() =>
        aggregateQuery([
          {
            _id: deleted._id,
            activeCount: 2,
            lastActiveAt: new Date('2026-08-15T02:00:00.000Z'),
          },
        ]),
      ),
    };
    const reports = {
      countDocuments: jest.fn<
        (filter: unknown) => ReturnType<typeof countQuery>
      >(() => countQuery(3)),
    };
    const auditEvents = {
      countDocuments: jest.fn<
        (filter: unknown) => ReturnType<typeof countQuery>
      >(() => countQuery(4)),
    };
    const service = new AdminUserQueryService(
      users as never,
      sessions as never,
      reports as never,
      auditEvents as never,
    );

    await expect(service.detail(deleted.publicId)).resolves.toMatchObject({
      publicId: deleted.publicId,
      deletion: {
        isDeleted: true,
        origin: UserDeletionOrigin.ADMIN_MODERATION,
      },
      sessionSummary: {
        activeCount: 2,
        lastActiveAt: '2026-08-15T02:00:00.000Z',
      },
      activitySummary: {
        reportCount: 3,
        moderationActionCount: 4,
      },
    });
    expect(reports.countDocuments).toHaveBeenCalledWith({
      targetType: 'USER',
      targetId: deleted._id,
    });
    expect(auditEvents.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'succeeded',
        'target.type': 'user',
        'target.publicId': deleted.publicId,
      }),
    );
    await expect(service.detail('usr_3456789ABC')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects ObjectId IDOR before persistence and sanitizes outages', async () => {
    const outage = Object.assign(new Error('mongodb.internal:27017'), {
      name: 'MongoServerSelectionError',
    });
    const failedQuery = chainedQuery(null);
    failedQuery.exec.mockRejectedValue(outage);
    const users = {
      find: jest.fn(),
      findOne: jest.fn(() => failedQuery),
    };
    const service = new AdminUserQueryService(
      users as never,
      {
        aggregate: jest.fn(),
      } as never,
      { countDocuments: jest.fn() } as never,
      { countDocuments: jest.fn() } as never,
    );

    await expect(
      service.detail('507f1f77bcf86cd799439011'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(users.findOne).not.toHaveBeenCalled();

    const result = service.detail('usr_456789ABCD');
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({
      response: {
        statusCode: 503,
        message: expect.not.stringMatching(/mongodb\.internal/u),
      },
    });
  });

  it('rejects pagination beyond the bounded offset before persistence', async () => {
    const context = serviceWith([]);

    await expect(
      context.service.list({
        page: 102,
        limit: 100,
        sort: AdminUserSort.CREATED_AT_DESC,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(context.users.find).not.toHaveBeenCalled();
  });
});
