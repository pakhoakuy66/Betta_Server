import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminJwtAuthGuard } from '../admin/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { ADMIN_PERMISSIONS_METADATA } from '../admin/decorators/require-admin-permissions.decorator';
import {
  AdminPermission,
  hasAdminPermission,
} from '../admin/constants/admin-permission.constants';
import { AdminRole } from '../admin/constants/admin-account.constants';
import {
  SponsoredMediaBody,
  SponsoredMediaController,
  SponsoredMediaParams,
} from './sponsored-media.controller';
describe('Sponsored media HTTP contract', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  it('binds both real Admin guards and the SuperAdmin-only update permission', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SponsoredMediaController),
    ).toEqual([AdminJwtAuthGuard, AdminPermissionGuard]);
    expect(
      Reflect.getMetadata(
        ADMIN_PERMISSIONS_METADATA,
        Reflect.get(SponsoredMediaController.prototype, 'replace') as object,
      ),
    ).toEqual([AdminPermission.SPONSORED_POSTS_UPDATE]);
    expect(
      hasAdminPermission(
        AdminRole.ADMIN,
        AdminPermission.SPONSORED_POSTS_UPDATE,
      ),
    ).toBe(false);
    expect(
      hasAdminPermission(
        AdminRole.SUPER_ADMIN,
        AdminPermission.SPONSORED_POSTS_UPDATE,
      ),
    ).toBe(true);
  });
  it.each(['publicId', 'url', 'transformation', 'uploadPreset', 'role'])(
    'rejects arbitrary multipart field %s',
    async (key) => {
      await expect(
        pipe.transform(
          { expectedVersion: '0', [key]: 'injected' },
          { type: 'body', metatype: SponsoredMediaBody },
        ),
      ).rejects.toThrow();
    },
  );
  it.each(['', ' ', '-1', '100000', 'abc', '1.5'])(
    'rejects invalid version %s',
    async (expectedVersion) => {
      await expect(
        pipe.transform(
          { expectedVersion },
          { type: 'body', metatype: SponsoredMediaBody },
        ),
      ).rejects.toThrow();
    },
  );
  it('rejects organic Post IDs on the sponsored route', async () => {
    await expect(
      pipe.transform(
        { publicId: 'post_23456789ABCD' },
        { type: 'param', metatype: SponsoredMediaParams },
      ),
    ).rejects.toThrow();
  });
});
