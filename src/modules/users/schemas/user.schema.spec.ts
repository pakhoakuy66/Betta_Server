import { describe, expect, it } from '@jest/globals';
import { model } from 'mongoose';

import {
  USER_MODERATION_SCHEMA_VERSION,
  UserDeletionOrigin,
  UserRestrictionType,
} from '../constants/user-moderation.constants';
import { User, UserSchema } from './user.schema';

const UserModel = model<User>('UserCredentialSchemaUnit', UserSchema);

const validUser = {
  publicId: 'usr_GoogleOnly1',
  username: 'google.user',
  fullname: 'Google User',
  phone: '0901234567',
  email: 'google@example.com',
};

describe('UserSchema', () => {
  it('keeps timestamps for transactional barriers', () => {
    expect(UserSchema.get('timestamps')).toBeTruthy();
    expect(UserSchema.path('updatedAt')).toBeDefined();
  });

  it('accepts an absent password', () => {
    expect(new UserModel(validUser).validateSync()).toBeUndefined();
  });

  it.each([null, ''])('rejects invalid password state: %p', (password) => {
    expect(
      new UserModel({
        ...validUser,
        password,
      }).validateSync(),
    ).toBeDefined();
  });

  it('excludes password from queries by default', () => {
    const path = UserSchema.path('password');

    expect(path.options.required).toBe(false);
    expect(path.options.select).toBe(false);
  });

  it('creates an active compatibility state with internal versions', () => {
    const user = new UserModel(validUser);

    expect(user.status).toBe('active');
    expect(user.isDeleted).toBe(false);
    expect(user.restriction).toBeNull();
    expect(user.deletionOrigin).toBeNull();
    expect(user.restorableUntil).toBeNull();
    expect(user.version).toBe(0);
    expect(user.authzVersion).toBe(0);
    expect(user.moderationSchemaVersion).toBe(USER_MODERATION_SCHEMA_VERSION);
    expect(user.validateSync()).toBeUndefined();
  });

  it('accepts a finite temporary suspension', () => {
    const effectiveAt = new Date('2026-08-15T00:00:00.000Z');
    const user = new UserModel({
      ...validUser,
      restriction: {
        type: UserRestrictionType.TEMPORARY_SUSPENSION,
        effectiveAt,
        expiresAt: new Date('2026-08-16T00:00:00.000Z'),
        supportReference: 'sup_23456789ABCDEFGH',
        publicReasonCode: 'policy_violation',
      },
    });

    expect(user.validateSync()).toBeUndefined();
  });

  it.each([
    null,
    new Date('2026-08-15T00:00:00.000Z'),
    new Date('2026-08-14T23:59:59.999Z'),
  ])('rejects an invalid temporary suspension expiry: %p', (expiresAt) => {
    const user = new UserModel({
      ...validUser,
      restriction: {
        type: UserRestrictionType.TEMPORARY_SUSPENSION,
        effectiveAt: new Date('2026-08-15T00:00:00.000Z'),
        expiresAt,
        supportReference: 'sup_23456789ABCDEFGH',
        publicReasonCode: 'policy_violation',
      },
    });

    expect(user.validateSync()?.errors['restriction.expiresAt']).toBeDefined();
  });

  it('accepts only a non-expiring indefinite ban', () => {
    const valid = new UserModel({
      ...validUser,
      restriction: {
        type: UserRestrictionType.INDEFINITE_BAN,
        effectiveAt: new Date('2026-08-15T00:00:00.000Z'),
        expiresAt: null,
        supportReference: 'sup_23456789ABCDEFGH',
        publicReasonCode: 'legacy_indefinite_ban',
      },
    });
    const invalid = new UserModel({
      ...validUser,
      email: 'second@example.com',
      username: 'second.user',
      phone: '0901234568',
      publicId: 'usr_GoogleOnly2',
      restriction: {
        type: UserRestrictionType.INDEFINITE_BAN,
        effectiveAt: new Date('2026-08-15T00:00:00.000Z'),
        expiresAt: new Date('2026-08-16T00:00:00.000Z'),
        supportReference: 'sup_23456789ABCDEFGH',
        publicReasonCode: 'legacy_indefinite_ban',
      },
    });

    expect(valid.validateSync()).toBeUndefined();
    expect(
      invalid.validateSync()?.errors['restriction.expiresAt'],
    ).toBeDefined();
  });

  it('keeps legacy banned documents valid before migration', () => {
    const user = new UserModel({
      ...validUser,
      status: 'banned',
      restriction: undefined,
    });

    expect(user.validateSync()).toBeUndefined();
  });

  it('accepts explicit deletion origin without changing legacy isDeleted', () => {
    const user = new UserModel({
      ...validUser,
      isDeleted: true,
      deletedAt: new Date('2026-08-15T00:00:00.000Z'),
      deletionOrigin: UserDeletionOrigin.USER_SELF_DELETED,
    });

    expect(user.validateSync()).toBeUndefined();
  });

  it('hides moderation state and migration fields by default', () => {
    for (const pathName of [
      'restriction',
      'deletionOrigin',
      'restorableUntil',
      'version',
      'authzVersion',
      'moderationSchemaVersion',
      'moderationMigration',
    ]) {
      expect(UserSchema.path(pathName).options.select).toBe(false);
    }
  });

  it('defines moderation query indexes without TTL deletion', () => {
    const indexes = UserSchema.indexes();
    const restriction = indexes.find(
      ([, options]) => options.name === 'user_restriction_type_expiry_id',
    );
    const deletion = indexes.find(
      ([, options]) => options.name === 'user_deletion_origin_deleted_id',
    );

    expect(restriction?.[0]).toEqual({
      'restriction.type': 1,
      'restriction.expiresAt': 1,
      _id: 1,
    });
    expect(deletion?.[0]).toEqual({
      deletionOrigin: 1,
      deletedAt: 1,
      _id: 1,
    });
    expect(restriction?.[1].partialFilterExpression).toEqual({
      'restriction.type': { $type: 'string' },
    });
    expect(deletion?.[1].partialFilterExpression).toEqual({
      deletionOrigin: { $type: 'string' },
    });
    for (const [, options] of indexes) {
      expect(options).not.toHaveProperty('expireAfterSeconds');
    }
  });
});
