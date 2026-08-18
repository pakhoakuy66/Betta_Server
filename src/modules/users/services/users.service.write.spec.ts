import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { MockedFunction } from 'jest-mock';
import * as bcrypt from 'bcrypt';
import type { ClientSession } from 'mongoose';
import { SessionRevokeReason } from '../../auth/schemas/auth-session.schema';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditReasonCode,
} from '../../auth/interfaces/auth-audit.interface';
import { DEFAULT_AVATAR_ID, DEFAULT_AVATAR_URL } from '../schemas/user.schema';
import { UserDeletionOrigin } from '../constants/user-moderation.constants';
import {
  CURRENT_USER_ID,
  createQuery,
  createUserSource,
  createUsersServiceContext,
} from './users.service.spec-helper';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
}));

type CompareFunction = (
  value: string | Buffer,
  encrypted: string,
) => Promise<boolean>;

const compareMock =
  bcrypt.compare as unknown as MockedFunction<CompareFunction>;

const avatarFile = {
  buffer: Buffer.from('avatar'),
  mimetype: 'image/webp',
  size: 6,
  originalname: 'avatar.webp',
};

const createTransactionSession = (): ClientSession => {
  const session = {
    withTransaction: jest.fn<
      (callback: () => Promise<unknown>) => Promise<unknown>
    >((callback) => callback()),

    endSession: jest.fn<() => Promise<void>>(() => Promise.resolve()),
  };

  return session as unknown as ClientSession;
};

const configureSuccessfulAccountDeletion = (
  context: ReturnType<typeof createUsersServiceContext>,
  session: ClientSession,
): void => {
  const { models, connection } = context;

  connection.startSession.mockResolvedValue(session);

  models.post.find.mockReturnValue(createQuery([]));
  models.reaction.find.mockReturnValue(createQuery([]));
  models.weeklyRecap.find.mockReturnValue(createQuery([]));

  models.user.updateOne.mockReturnValue(
    createQuery({
      matchedCount: 1,
      modifiedCount: 1,
    }),
  );

  models.relationship.find.mockReturnValue(createQuery([]));

  const emptyDeleteResult = {
    acknowledged: true,
    deletedCount: 0,
  };

  const emptyUpdateResult = {
    acknowledged: true,
    matchedCount: 0,
    modifiedCount: 0,
  };

  models.relationship.deleteMany.mockReturnValue(
    createQuery(emptyDeleteResult),
  );
  models.block.deleteMany.mockReturnValue(createQuery(emptyDeleteResult));
  models.post.deleteMany.mockReturnValue(createQuery(emptyDeleteResult));
  models.reaction.deleteMany.mockReturnValue(createQuery(emptyDeleteResult));
  models.postShare.deleteMany.mockReturnValue(createQuery(emptyDeleteResult));
  models.notification.deleteMany.mockReturnValue(
    createQuery(emptyDeleteResult),
  );
  models.engagementEvent.deleteMany.mockReturnValue(
    createQuery(emptyDeleteResult),
  );
  models.weeklyRecap.deleteMany.mockReturnValue(createQuery(emptyDeleteResult));
  models.weeklyRecap.updateMany.mockReturnValue(createQuery(emptyUpdateResult));
  models.streakHistory.deleteMany.mockReturnValue(
    createQuery(emptyDeleteResult),
  );
  models.reportCooldown.deleteMany.mockReturnValue(
    createQuery(emptyDeleteResult),
  );
};

describe('UsersService write flows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    compareMock.mockResolvedValue(false);
  });

  describe('updateProfile', () => {
    it('rejects an empty update payload', async () => {
      const { service, models } = createUsersServiceContext();

      await expect(
        service.updateProfile(CURRENT_USER_ID.toString(), {}),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(models.user.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects a username owned by another active user', async () => {
      const { service, models } = createUsersServiceContext();

      models.user.findOne.mockReturnValue(
        createQuery({ _id: CURRENT_USER_ID }),
      );

      await expect(
        service.updateProfile(CURRENT_USER_ID.toString(), {
          username: 'existing_user',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(models.user.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('updates only allowed fields and returns a sanitized contract', async () => {
      const { service, models } = createUsersServiceContext();
      const updatedUser = createUserSource({
        username: 'updated_user',
        bio: 'Updated bio',
      });

      models.user.findOne.mockReturnValue(createQuery(null));
      models.user.findOneAndUpdate.mockReturnValue(createQuery(updatedUser));

      const result = await service.updateProfile(CURRENT_USER_ID.toString(), {
        username: 'updated_user',
        bio: 'Updated bio',
      });

      expect(models.user.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: CURRENT_USER_ID,
          isDeleted: false,
          status: 'active',
        },
        {
          $set: {
            username: 'updated_user',
            bio: 'Updated bio',
          },
        },
        { new: true, runValidators: true },
      );
      expect(result.data).toStrictEqual({
        id: updatedUser.publicId,
        publicId: updatedUser.publicId,
        username: 'updated_user',
        fullname: updatedUser.fullname,
        email: updatedUser.email,
        phone: updatedUser.phone,
        avatar: updatedUser.avatar,
        hasCustomAvatar: false,
        bio: 'Updated bio',
        link: '',
        streakCount: 3,
        postsCount: 2,
        followersCount: 0,
        followingCount: 0,
        status: 'active',
        notificationSettings: updatedUser.notificationSettings,
      });
    });
  });

  describe('updateAvatar', () => {
    it('rejects a missing upload before querying MongoDB', async () => {
      const { service, models, uploadsService } = createUsersServiceContext();

      await expect(
        service.updateAvatar(CURRENT_USER_ID.toString()),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(models.user.findOne).not.toHaveBeenCalled();
      expect(uploadsService.uploadAvatar).not.toHaveBeenCalled();
    });

    it('updates avatar and deletes the previous custom asset', async () => {
      const { service, models, uploadsService } = createUsersServiceContext();
      const updatedUser = createUserSource({
        avatar: 'https://example.com/new-avatar.webp',
        avatarId: 'betta/avatars/new-avatar',
      });

      models.user.findOne.mockReturnValue(
        createQuery({
          _id: CURRENT_USER_ID,
          avatarId: 'betta/avatars/old-avatar',
        }),
      );
      uploadsService.uploadAvatar.mockResolvedValue({
        url: 'https://example.com/new-avatar.webp',
        publicId: 'betta/avatars/new-avatar',
        width: 512,
        height: 512,
        format: 'webp',
        bytes: 1024,
      });
      models.user.findOneAndUpdate.mockReturnValue(createQuery(updatedUser));

      const result = await service.updateAvatar(
        CURRENT_USER_ID.toString(),
        avatarFile,
      );

      expect(uploadsService.deleteImage).toHaveBeenCalledWith(
        'betta/avatars/old-avatar',
      );
      expect(result.data.avatar).toBe('https://example.com/new-avatar.webp');
      expect(result.data.hasCustomAvatar).toBe(true);
    });

    it('deletes the newly uploaded asset when the database update fails', async () => {
      const { service, models, uploadsService } = createUsersServiceContext();
      const databaseError = new Error('database failed');

      models.user.findOne.mockReturnValue(
        createQuery({ _id: CURRENT_USER_ID, avatarId: DEFAULT_AVATAR_ID }),
      );
      uploadsService.uploadAvatar.mockResolvedValue({
        url: 'https://example.com/new-avatar.webp',
        publicId: 'betta/avatars/new-avatar',
        width: 512,
        height: 512,
        format: 'webp',
        bytes: 1024,
      });
      models.user.findOneAndUpdate.mockReturnValue(
        createQuery(null, databaseError),
      );

      await expect(
        service.updateAvatar(CURRENT_USER_ID.toString(), avatarFile),
      ).rejects.toBe(databaseError);

      expect(uploadsService.deleteImage).toHaveBeenCalledWith(
        'betta/avatars/new-avatar',
      );
    });
  });

  describe('removeAvatar', () => {
    it('returns immediately when the default avatar is already active', async () => {
      const { service, models, uploadsService } = createUsersServiceContext();
      const user = createUserSource();

      models.user.findOne.mockReturnValue(createQuery(user));

      const result = await service.removeAvatar(CURRENT_USER_ID.toString());

      expect(result.message).toBe('Avatar đang là ảnh mặc định');
      expect(models.user.findOneAndUpdate).not.toHaveBeenCalled();
      expect(uploadsService.deleteImage).not.toHaveBeenCalled();
    });

    it('restores defaults before deleting the old custom asset', async () => {
      const { service, models, uploadsService } = createUsersServiceContext();
      const currentUser = createUserSource({
        avatarId: 'betta/avatars/custom-avatar',
      });
      const updatedUser = createUserSource();

      models.user.findOne.mockReturnValue(createQuery(currentUser));
      models.user.findOneAndUpdate.mockReturnValue(createQuery(updatedUser));

      await service.removeAvatar(CURRENT_USER_ID.toString());

      expect(models.user.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: CURRENT_USER_ID,
          isDeleted: false,
          status: 'active',
        },
        {
          $set: {
            avatar: DEFAULT_AVATAR_URL,
            avatarId: DEFAULT_AVATAR_ID,
          },
        },
        { new: true, runValidators: true },
      );
      expect(uploadsService.deleteImage).toHaveBeenCalledWith(
        'betta/avatars/custom-avatar',
      );
    });
  });

  describe('updateMyNotificationSettings', () => {
    it('rejects a payload without boolean settings', async () => {
      const { service, models } = createUsersServiceContext();

      await expect(
        service.updateMyNotificationSettings(CURRENT_USER_ID.toString(), {}),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(models.user.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('updates only explicitly provided settings', async () => {
      const { service, models } = createUsersServiceContext();

      models.user.findOneAndUpdate.mockReturnValue(
        createQuery({
          notificationSettings: {
            enabled: true,
            follow: false,
            reaction: true,
            recap: false,
          },
        }),
      );

      const result = await service.updateMyNotificationSettings(
        CURRENT_USER_ID.toString(),
        { follow: false, recap: false },
      );

      expect(models.user.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: CURRENT_USER_ID.toString(),
          isDeleted: false,
          status: 'active',
        },
        {
          $set: {
            'notificationSettings.follow': false,
            'notificationSettings.recap': false,
          },
        },
        {
          new: true,
          projection: { notificationSettings: 1 },
        },
      );
      expect(result.data).toStrictEqual({
        enabled: true,
        follow: false,
        reaction: true,
        recap: false,
      });
    });
  });

  describe('softDeleteUser', () => {
    it('rejects an invalid user id before querying MongoDB', async () => {
      const { service, models } = createUsersServiceContext();

      await expect(
        service.softDeleteUser('invalid-id', 'Password@123'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(models.user.findOne).not.toHaveBeenCalled();
    });

    it('rejects an incorrect password before opening a transaction', async () => {
      const { service, models, connection, authSessionService } =
        createUsersServiceContext();

      const user = createUserSource();

      models.user.findOne.mockReturnValue(createQuery(user));

      compareMock.mockResolvedValue(false);

      await expect(
        service.softDeleteUser(CURRENT_USER_ID.toString(), 'WrongPassword@1'),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(connection.startSession).not.toHaveBeenCalled();

      expect(authSessionService.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('does not revoke sessions when the user is already deleted', async () => {
      const { service, models, connection, authSessionService } =
        createUsersServiceContext();

      models.user.findOne.mockReturnValue(createQuery(null));

      await expect(
        service.softDeleteUser(CURRENT_USER_ID.toString(), 'Password@123'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(connection.startSession).not.toHaveBeenCalled();

      expect(authSessionService.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('revokes every session with the transaction used by account deletion', async () => {
      const context = createUsersServiceContext();

      const { service, models, authSessionService, authAuditService } = context;

      const transactionSession = createTransactionSession();

      const user = createUserSource({
        _id: CURRENT_USER_ID,
      });

      models.user.findOne.mockReturnValue(createQuery(user));

      compareMock.mockResolvedValue(true);

      configureSuccessfulAccountDeletion(context, transactionSession);
      authSessionService.revokeAllSessions.mockResolvedValue(4);

      await expect(
        service.softDeleteUser(CURRENT_USER_ID.toString(), 'Password@123'),
      ).resolves.toEqual({
        success: true,
        message: 'Đã xóa tài khoản thành công',
      });

      expect(authSessionService.revokeAllSessions).toHaveBeenCalledTimes(1);

      const [calledUserId, calledReason, calledSession] =
        authSessionService.revokeAllSessions.mock.calls[0];

      expect(calledUserId.toString()).toBe(CURRENT_USER_ID.toString());

      expect(calledReason).toBe(SessionRevokeReason.ACCOUNT_DELETED);

      expect(calledSession).toBe(transactionSession);

      expect(authAuditService.record).toHaveBeenCalledTimes(1);

      const [auditInput] = authAuditService.record.mock.calls[0];

      expect(auditInput.eventCode).toBe(AuthAuditEventCode.ACCOUNT_DELETED);
      expect(auditInput.outcome).toBe(AuthAuditOutcome.SUCCEEDED);
      expect(auditInput.reasonCode).toBe(
        AuthAuditReasonCode.ACCOUNT_DELETION_COMPLETED,
      );
      expect(auditInput.targetUserId.toString()).toBe(
        CURRENT_USER_ID.toString(),
      );
      expect(auditInput.actorUserId?.toString()).toBe(
        CURRENT_USER_ID.toString(),
      );
      expect(auditInput.metadata).toEqual({ affectedSessionCount: 4 });
      expect(auditInput.mongoSession).toBe(transactionSession);

      expect(models.user.updateOne).toHaveBeenCalledWith(
        {
          _id: CURRENT_USER_ID,
          isDeleted: false,
          status: 'active',
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            isDeleted: true,
            deletionOrigin: UserDeletionOrigin.USER_SELF_DELETED,
            restorableUntil: null,
          }),
          $inc: {
            version: 1,
            authzVersion: 1,
          },
        }),
        { session: transactionSession },
      );
    });

    it('maps an audit infrastructure failure to service unavailable', async () => {
      const context = createUsersServiceContext();
      const { service, models, authAuditService } = context;
      const transactionSession = createTransactionSession();

      models.user.findOne.mockReturnValue(
        createQuery(createUserSource({ _id: CURRENT_USER_ID })),
      );
      compareMock.mockResolvedValue(true);
      configureSuccessfulAccountDeletion(context, transactionSession);
      authAuditService.record.mockRejectedValue(
        Object.assign(new Error('audit unavailable'), {
          name: 'MongoServerSelectionError',
        }),
      );

      await expect(
        service.softDeleteUser(CURRENT_USER_ID.toString(), 'Password@123'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('preserves a non-Mongo audit error', async () => {
      const context = createUsersServiceContext();
      const { service, models, authAuditService } = context;
      const transactionSession = createTransactionSession();
      const expectedError = new Error('programming failure');

      models.user.findOne.mockReturnValue(
        createQuery(createUserSource({ _id: CURRENT_USER_ID })),
      );
      compareMock.mockResolvedValue(true);
      configureSuccessfulAccountDeletion(context, transactionSession);
      authAuditService.record.mockRejectedValue(expectedError);

      await expect(
        service.softDeleteUser(CURRENT_USER_ID.toString(), 'Password@123'),
      ).rejects.toBe(expectedError);
    });
  });
});
