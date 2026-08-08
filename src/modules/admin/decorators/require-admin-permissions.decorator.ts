import { SetMetadata } from '@nestjs/common';
import {
  isAdminPermission,
  type AdminPermission,
} from '../constants/admin-permission.constants';

export const ADMIN_PERMISSIONS_METADATA = Symbol('ADMIN_PERMISSIONS_METADATA');

export const RequireAdminPermissions = (...permissions: AdminPermission[]) => {
  if (permissions.length === 0) {
    throw new TypeError(
      'RequireAdminPermissions yêu cầu ít nhất một permission',
    );
  }

  if (!permissions.every(isAdminPermission)) {
    throw new TypeError('Admin permission metadata không hợp lệ');
  }

  const uniquePermissions = Object.freeze([
    ...new Set<AdminPermission>(permissions),
  ]);

  return SetMetadata(ADMIN_PERMISSIONS_METADATA, uniquePermissions);
};
