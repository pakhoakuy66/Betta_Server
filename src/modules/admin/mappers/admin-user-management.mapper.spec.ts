import { describe, expect, it } from '@jest/globals';
import { Types } from 'mongoose';
import {
  UserDeletionOrigin,
  UserRestrictionType,
} from '../../users/constants/user-moderation.constants';
import { USER_STATUS } from '../../users/schemas/user.schema';
import {
  toPublicAdminUserDetail,
  toPublicAdminUserListItem,
} from './admin-user-management.mapper';

const source = () => ({
  _id: new Types.ObjectId(),
  publicId: 'usr_23456789AB',
  username: 'managed.user',
  fullname: 'Managed User',
  email: 'managed.user@betta.test',
  phone: '0394281845',
  avatar: 'https://cdn.example/avatar.webp',
  bio: 'Profile bio',
  link: 'https://example.com',
  status: USER_STATUS.ACTIVE,
  isDeleted: false,
  deletedAt: null,
  deletionOrigin: UserDeletionOrigin.ADMIN_MODERATION,
  restorableUntil: new Date('2026-09-01T00:00:00.000Z'),
  restriction: {
    type: UserRestrictionType.TEMPORARY_SUSPENSION,
    effectiveAt: new Date('2026-08-15T00:00:00.000Z'),
    expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    supportReference: 'sup_12345678',
    publicReasonCode: 'policy.violation',
  },
  version: 7,
  lockedUntil: new Date('2026-08-16T00:00:00.000Z'),
  streakCount: 4,
  postsCount: 8,
  followersCount: 9,
  followingCount: 10,
  lastActive: new Date('2026-08-15T01:00:00.000Z'),
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-15T00:00:00.000Z'),
});

describe('admin User management mapper', () => {
  it('masks contact and exposes only the explicit list contract', () => {
    const input = source();
    const result = toPublicAdminUserListItem(
      input,
      new Date('2026-08-15T12:00:00.000Z'),
    );
    const serialized = JSON.stringify(result);

    expect(result.contact).toEqual({
      email: 'm***@betta.test',
      phone: '******1845',
    });
    expect(result.loginLock.isLocked).toBe(true);
    expect(result.version).toBe(7);
    expect(serialized).not.toContain(input._id.toHexString());
    expect(serialized).not.toContain(input.email);
    expect(serialized).not.toContain(input.phone);
    expect(result).not.toHaveProperty('bio');
  });

  it('adds profile and count-only activity summaries only to detail', () => {
    const result = toPublicAdminUserDetail(
      source(),
      {
        activeCount: 2,
        lastActiveAt: '2026-08-15T02:00:00.000Z',
      },
      { reportCount: 3, moderationActionCount: 4 },
    );

    expect(result.profile).toEqual({
      bio: 'Profile bio',
      link: 'https://example.com',
      streakCount: 4,
      postsCount: 8,
      followersCount: 9,
      followingCount: 10,
    });
    expect(result.sessionSummary.activeCount).toBe(2);
    expect(result.activitySummary).toEqual({
      reportCount: 3,
      moderationActionCount: 4,
    });
  });
});
