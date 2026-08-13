import { describe, expect, it } from '@jest/globals';
import { model, Types } from 'mongoose';
import {
  ADMIN_BOOTSTRAP_SINGLETON_KEY,
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
} from '../constants/admin-bootstrap.constants';
import {
  ADMIN_BOOTSTRAP_STATE_ACCOUNT_INDEX,
  ADMIN_BOOTSTRAP_STATE_KEY_INDEX,
  AdminBootstrapStateSchema,
} from './admin-bootstrap-state.schema';

describe('AdminBootstrapStateSchema', () => {
  const BootstrapModel = model(
    `AdminBootstrapStateSpec${Date.now()}`,
    AdminBootstrapStateSchema,
  );

  const source = () => ({
    key: ADMIN_BOOTSTRAP_SINGLETON_KEY,
    adminAccountId: new Types.ObjectId(),
    adminPublicId: 'adm_23456789ABCD',
    purpose: AdminActivationGrantPurpose.BOOTSTRAP_SUPER_ADMIN,
    environment: AdminBootstrapEnvironment.TEST,
    generation: 1,
    grantHash: 'a'.repeat(64),
    grantExpiresAt: new Date(Date.now() + 900_000),
    consumedAt: null,
    secretReference: 'sm://betta/admin-bootstrap/versions/1',
  });

  it('accepts the strict singleton bootstrap contract', async () => {
    await expect(new BootstrapModel(source()).validate()).resolves.toBeFalsy();
  });

  it('rejects malformed state and unknown fields', async () => {
    const invalid = new BootstrapModel({
      ...source(),
      generation: 0,
      grantHash: 'raw-grant',
    });
    await expect(invalid.validate()).rejects.toThrow();
    expect(
      () => new BootstrapModel({ ...source(), rawGrant: 'secret' }),
    ).toThrow();
  });

  it('hides grant material and secret references by default', () => {
    expect(AdminBootstrapStateSchema.path('grantHash').options.select).toBe(
      false,
    );
    expect(
      AdminBootstrapStateSchema.path('secretReference').options.select,
    ).toBe(false);
    expect(AdminBootstrapStateSchema.path('consumedAt').options.select).toBe(
      false,
    );
  });

  it('defines only the approved unique indexes and no TTL index', () => {
    const indexes = AdminBootstrapStateSchema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { key: 1 },
          expect.objectContaining({
            name: ADMIN_BOOTSTRAP_STATE_KEY_INDEX,
            unique: true,
          }),
        ],
        [
          { adminPublicId: 1 },
          expect.objectContaining({
            name: ADMIN_BOOTSTRAP_STATE_ACCOUNT_INDEX,
            unique: true,
          }),
        ],
      ]),
    );
    expect(indexes.some(([, options]) => 'expireAfterSeconds' in options)).toBe(
      false,
    );
  });
});
