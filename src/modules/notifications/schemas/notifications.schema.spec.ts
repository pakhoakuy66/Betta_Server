import { describe, expect, it } from '@jest/globals';
import {
  NotificationSchema,
  NOTIFICATION_TTL_DAYS,
  NOTIFICATION_TTL_MS,
} from './notifications.schema';
import {
  generateNotificationPublicId,
  isValidNotificationPublicId,
} from '../utils/notification-public-id';

describe('NotificationSchema', () => {
  it('keeps the 14-day retention contract', () => {
    expect(NOTIFICATION_TTL_DAYS).toBe(14);
    expect(NOTIFICATION_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('defines an immediate TTL index on expiresAt', () => {
    const expiresAtIndex = NotificationSchema.indexes().find(
      ([fields]) => fields.expiresAt === 1,
    );

    expect(expiresAtIndex).toBeDefined();
    expect(expiresAtIndex?.[1]).toMatchObject({
      expireAfterSeconds: 0,
    });
  });

  it('keeps the sparse unique dedupe index', () => {
    const dedupeIndex = NotificationSchema.indexes().find(
      ([fields]) => fields.dedupeKey === 1,
    );

    expect(dedupeIndex?.[1]).toMatchObject({
      unique: true,
      sparse: true,
    });
  });

  it('generates valid unique notification public IDs', () => {
    const publicIds = Array.from({ length: 100 }, generateNotificationPublicId);

    expect(publicIds.every(isValidNotificationPublicId)).toBe(true);

    expect(new Set(publicIds).size).toBe(publicIds.length);
  });

  it('keeps the transitional sparse unique publicId index', () => {
    const publicIdIndex = NotificationSchema.indexes().find(
      ([fields]) => fields.publicId === 1,
    );

    expect(publicIdIndex?.[1]).toMatchObject({
      unique: true,
      sparse: true,
      name: 'notifications_publicId_unique',
    });
  });
});
