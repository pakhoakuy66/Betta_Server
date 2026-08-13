import { describe, expect, it } from '@jest/globals';
import { model } from 'mongoose';
import { ADMIN_LIFECYCLE_COORDINATOR_KEY } from '../constants/admin-lifecycle.constants';
import {
  ADMIN_LIFECYCLE_COORDINATOR_KEY_INDEX,
  AdminLifecycleCoordinatorSchema,
} from './admin-lifecycle-coordinator.schema';

describe('AdminLifecycleCoordinatorSchema', () => {
  const CoordinatorModel = model(
    `AdminLifecycleCoordinatorSpec${Date.now()}`,
    AdminLifecycleCoordinatorSchema,
  );

  it('accepts only the strict singleton coordinator contract', async () => {
    await expect(
      new CoordinatorModel({
        key: ADMIN_LIFECYCLE_COORDINATOR_KEY,
        revision: 0,
      }).validate(),
    ).resolves.toBeFalsy();

    expect(
      () =>
        new CoordinatorModel({
          key: ADMIN_LIFECYCLE_COORDINATOR_KEY,
          revision: 0,
          rawGrant: 'must-not-exist',
        }),
    ).toThrow();
    await expect(
      new CoordinatorModel({ key: 'other', revision: -1 }).validate(),
    ).rejects.toThrow();
  });

  it('defines one unique coordinator key and no TTL cleanup', () => {
    const indexes = AdminLifecycleCoordinatorSchema.indexes();
    expect(indexes).toContainEqual([
      { key: 1 },
      expect.objectContaining({
        name: ADMIN_LIFECYCLE_COORDINATOR_KEY_INDEX,
        unique: true,
      }),
    ]);
    expect(indexes.some(([, options]) => 'expireAfterSeconds' in options)).toBe(
      false,
    );
  });
});
