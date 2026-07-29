import { describe, expect, it } from '@jest/globals';
import { model } from 'mongoose';

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
});
