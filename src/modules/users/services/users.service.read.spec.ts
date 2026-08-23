import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BLOCKED_USER_ID,
  CURRENT_USER_ID,
  TARGET_USER_ID,
  createQuery,
  createUserSource,
  createUsersServiceContext,
} from './users.service.spec-helper';

describe('UsersService read flows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('searchUsers', () => {
    it('escapes regex input, excludes hidden users and paginates safely', async () => {
      const { service, models } = createUsersServiceContext();
      const blockQuery = createQuery([
        {
          blockerId: CURRENT_USER_ID,
          blockedId: BLOCKED_USER_ID,
        },
      ]);
      const userQuery = createQuery([
        createUserSource({ publicId: 'usr_result01', username: 'a+b_one' }),
        createUserSource({ publicId: 'usr_result02', username: 'a+b_two' }),
        createUserSource({ publicId: 'usr_result03', username: 'a+b_three' }),
      ]);

      models.block.find.mockReturnValue(blockQuery);
      models.user.find.mockReturnValue(userQuery);

      const result = await service.searchUsers(CURRENT_USER_ID.toString(), {
        q: ' a+b ',
        page: 2,
        limit: 2,
      });

      const filter = models.user.find.mock.calls[0]?.[0] as {
        $and: Array<Record<string, unknown>>;
      };
      const baseFilter = filter.$and[0] as {
        username: { $regex: string; $options: string };
        _id: { $nin: unknown[] };
      };

      expect(baseFilter.username).toStrictEqual({
        $regex: 'a\\+b',
        $options: 'i',
      });
      expect(baseFilter._id.$nin).toEqual([CURRENT_USER_ID, BLOCKED_USER_ID]);
      expect(filter.$and[1]).toEqual(
        expect.objectContaining({
          isDeleted: false,
          status: 'active',
          $or: expect.any(Array),
        }),
      );
      expect(userQuery.skip).toHaveBeenCalledWith(2);
      expect(userQuery.limit).toHaveBeenCalledWith(3);
      expect(result.pagination).toStrictEqual({
        page: 2,
        limit: 2,
        hasMore: true,
      });
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toStrictEqual({
        id: 'usr_result01',
        publicId: 'usr_result01',
        username: 'a+b_one',
        fullname: 'Target User',
        avatar: expect.any(String),
        bio: '',
        streakCount: 3,
      });
    });
  });

  describe('suggestUsers', () => {
    it('rejects an invalid current user id before querying MongoDB', async () => {
      const { service, models } = createUsersServiceContext();

      await expect(
        service.suggestUsers('invalid-id', {
          limit: 10,
          excludePublicIds: [],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(models.user.findOne).not.toHaveBeenCalled();
    });

    it('excludes self, followed, blocked and client-provided users', async () => {
      const { service, models } = createUsersServiceContext();
      const followedId = TARGET_USER_ID;
      const suggestedUser = createUserSource({
        publicId: 'usr_suggest01',
        username: 'suggested_user',
        followersCount: 8,
      });

      models.user.findOne.mockReturnValue(
        createQuery({ _id: CURRENT_USER_ID }),
      );
      models.relationship.find.mockReturnValue(
        createQuery([{ followingId: followedId }]),
      );
      models.block.find.mockReturnValue(
        createQuery([
          {
            blockerId: BLOCKED_USER_ID,
            blockedId: CURRENT_USER_ID,
          },
        ]),
      );
      models.user.aggregate.mockReturnValue(createQuery([suggestedUser]));

      const result = await service.suggestUsers(CURRENT_USER_ID.toString(), {
        limit: 5,
        excludePublicIds: ['usr_seen001'],
      });

      const pipeline = models.user.aggregate.mock.calls[0]?.[0] as Array<{
        $match?: Record<string, unknown>;
      }>;
      const match = pipeline[0]?.$match as {
        _id: { $nin: unknown[] };
        publicId: { $nin: string[] };
      };

      expect(match._id.$nin).toEqual([
        CURRENT_USER_ID,
        followedId,
        BLOCKED_USER_ID,
      ]);
      expect(match.publicId).toStrictEqual({ $nin: ['usr_seen001'] });
      expect(result).toStrictEqual({
        success: true,
        data: [
          {
            id: 'usr_suggest01',
            publicId: 'usr_suggest01',
            username: 'suggested_user',
            fullname: 'Target User',
            avatar: suggestedUser.avatar,
            bio: '',
            streakCount: 3,
            followersCount: 8,
          },
        ],
        meta: {
          limit: 5,
          count: 1,
        },
      });
    });
  });

  describe('getProfileByUsername', () => {
    it('hides a profile when either user has blocked the other', async () => {
      const { service, models } = createUsersServiceContext();

      models.user.findOne.mockReturnValue(createQuery(createUserSource()));
      models.block.findOne.mockReturnValue(
        createQuery({ _id: BLOCKED_USER_ID }),
      );

      await expect(
        service.getProfileByUsername('target_user', CURRENT_USER_ID.toString()),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(models.relationship.findOne).not.toHaveBeenCalled();
      expect(models.relationship.aggregate).not.toHaveBeenCalled();
    });

    it('returns the exact public profile and live relationship counts', async () => {
      const { service, models } = createUsersServiceContext();
      const profile = createUserSource({
        avatarId: 'betta/avatars/custom',
        bio: 'Public bio',
        link: 'https://example.com',
      });

      models.user.findOne.mockReturnValue(createQuery(profile));
      models.block.findOne.mockReturnValue(createQuery(null));
      models.relationship.findOne.mockReturnValue(
        createQuery({ _id: TARGET_USER_ID }),
      );
      models.relationship.aggregate
        .mockReturnValueOnce(Promise.resolve([{ total: 7 }]))
        .mockReturnValueOnce(Promise.resolve([{ total: 4 }]));

      const result = await service.getProfileByUsername(
        'target_user',
        CURRENT_USER_ID.toString(),
      );

      expect(result).toStrictEqual({
        success: true,
        data: {
          id: 'usr_tXdqiPs9aK',
          publicId: 'usr_tXdqiPs9aK',
          username: 'target_user',
          fullname: 'Target User',
          avatar: profile.avatar,
          hasCustomAvatar: true,
          bio: 'Public bio',
          link: 'https://example.com',
          streakCount: 3,
          postsCount: 2,
          followersCount: 7,
          followingCount: 4,
          isFollowing: true,
          isBlocked: false,
        },
      });
    });
  });

  describe('getMyNotificationSettings', () => {
    it('fills missing settings with secure defaults', async () => {
      const { service, models } = createUsersServiceContext();

      models.user.findOne.mockReturnValue(
        createQuery({ notificationSettings: { follow: false } }),
      );

      await expect(
        service.getMyNotificationSettings(CURRENT_USER_ID.toString()),
      ).resolves.toStrictEqual({
        success: true,
        data: {
          enabled: true,
          follow: false,
          reaction: true,
          recap: true,
        },
      });
    });
  });
});
