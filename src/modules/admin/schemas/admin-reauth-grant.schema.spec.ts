import { describe, expect, it } from '@jest/globals';
import { model, models, type Model, Types } from 'mongoose';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import {
  AdminReauthGrant,
  AdminReauthGrantSchema,
} from './admin-reauth-grant.schema';

const MODEL = 'AdminReauthGrantSchemaTest';
const TestModel =
  (models[MODEL] as Model<AdminReauthGrant> | undefined) ??
  model<AdminReauthGrant>(MODEL, AdminReauthGrantSchema.clone());

const source = () => ({
  adminAccountId: new Types.ObjectId(),
  adminPublicId: 'adm_23456789ABCD',
  sessionPublicId: 'ases_23456789ABCDEFGH',
  purpose: AdminReauthPurpose.ADMIN_MFA_RESET,
  targetPublicId: 'adm_ABCDEFGHJKLM',
  grantHash: 'b'.repeat(64),
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
  expiresAt: new Date(Date.now() + 300_000),
  consumedAt: null,
});

describe('AdminReauthGrantSchema', () => {
  it('accepts a purpose and target-bound strict contract', () => {
    expect(new TestModel(source()).validateSync()).toBeUndefined();
    expect(AdminReauthGrantSchema.get('strict')).toBe('throw');
  });

  it('hides grant hash and security-version bindings', () => {
    for (const field of [
      'adminAccountId',
      'grantHash',
      'credentialVersion',
      'authzVersion',
      'permissionVersion',
    ]) {
      expect(AdminReauthGrantSchema.path(field).options.select).toBe(false);
    }
  });

  it('defines one unique hash and absolute TTL cleanup', () => {
    const indexes = AdminReauthGrantSchema.indexes();
    expect(
      indexes.some(([keys, options]) => keys.grantHash === 1 && options.unique),
    ).toBe(true);
    expect(
      indexes.some(
        ([keys, options]) =>
          keys.expiresAt === 1 && options.expireAfterSeconds === 0,
      ),
    ).toBe(true);
  });

  it('rejects cross-namespace principals, sessions and targets', () => {
    expect(
      new TestModel({ ...source(), adminPublicId: 'usr_wrong' }).validateSync(),
    ).toBeDefined();
    expect(
      new TestModel({
        ...source(),
        sessionPublicId: 'ses_wrong',
      }).validateSync(),
    ).toBeDefined();
    expect(
      new TestModel({ ...source(), targetPublicId: 'bad' }).validateSync(),
    ).toBeDefined();
  });
});
