import { describe, expect, it } from '@jest/globals';
import { model, models, type Model, Types } from 'mongoose';
import { AdminRecoveryPurpose } from '../constants/admin-account-recovery.constants';
import {
  AdminRecoveryGrant,
  AdminRecoveryGrantSchema,
} from './admin-recovery-grant.schema';

const MODEL = 'AdminRecoveryGrantSchemaTest';
const TestModel =
  (models[MODEL] as Model<AdminRecoveryGrant> | undefined) ??
  model<AdminRecoveryGrant>(MODEL, AdminRecoveryGrantSchema.clone());

const source = () => ({
  targetAdminAccountId: new Types.ObjectId(),
  targetAdminPublicId: 'adm_23456789ABCD',
  purpose: AdminRecoveryPurpose.ADMIN_MFA_RESET,
  grantHash: 'a'.repeat(64),
  credentialVersionAtIssue: 2,
  secretReference: 'sm://betta/admin-recovery/versions/1',
  expiresAt: new Date(Date.now() + 900_000),
  consumedAt: null,
  revokedAt: null,
});

describe('AdminRecoveryGrantSchema', () => {
  it('accepts the strict hash-only recovery contract', () => {
    const document = new TestModel(source());
    expect(document.validateSync()).toBeUndefined();
    expect(AdminRecoveryGrantSchema.get('strict')).toBe('throw');
  });

  it('hides hash, owner id, versions and secret reference by default', () => {
    for (const field of [
      'targetAdminAccountId',
      'grantHash',
      'credentialVersionAtIssue',
      'secretReference',
    ]) {
      expect(AdminRecoveryGrantSchema.path(field).options.select).toBe(false);
    }
  });

  it('defines unique hash, TTL and target-purpose indexes', () => {
    const indexes = AdminRecoveryGrantSchema.indexes();
    expect(
      indexes.some(([keys, options]) => keys.grantHash === 1 && options.unique),
    ).toBe(true);
    expect(
      indexes.some(
        ([keys, options]) =>
          keys.expiresAt === 1 && options.expireAfterSeconds === 0,
      ),
    ).toBe(true);
    expect(
      indexes.some(
        ([keys]) => keys.targetAdminPublicId === 1 && keys.purpose === 1,
      ),
    ).toBe(true);
  });

  it('rejects raw grants, malformed owners and unknown fields', () => {
    expect(
      new TestModel({ ...source(), grantHash: 'raw-grant' }).validateSync(),
    ).toBeDefined();
    expect(
      new TestModel({
        ...source(),
        targetAdminPublicId: 'usr_wrong',
      }).validateSync(),
    ).toBeDefined();
    expect(() => new TestModel({ ...source(), rawGrant: 'secret' })).toThrow();
  });
});
