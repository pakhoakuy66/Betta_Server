import 'reflect-metadata';
import {
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from '@jest/globals';
import { AdminRole } from '../constants/admin-account.constants';
import {
  AdminPermission,
  type AdminPermission as AdminPermissionType,
} from '../constants/admin-permission.constants';
import {
  ADMIN_PERMISSIONS_METADATA,
  RequireAdminPermissions,
} from '../decorators/require-admin-permissions.decorator';
import { type AdminRequestPrincipal } from '../types/admin-authenticated-request';
import { AdminPermissionGuard } from './admin-permission.guard';

class UserViewRoute {
  @RequireAdminPermissions(AdminPermission.USERS_VIEW)
  handle(this: void): void {}
}

class MultiPermissionRoute {
  @RequireAdminPermissions(
    AdminPermission.REPORTS_RESOLVE,
    AdminPermission.USERS_BAN,
  )
  handle(this: void): void {}
}

@RequireAdminPermissions(AdminPermission.USERS_VIEW)
class LayeredPermissionRoute {
  @RequireAdminPermissions(AdminPermission.USERS_BAN)
  handle(this: void): void {}
}

@RequireAdminPermissions(AdminPermission.USERS_VIEW)
class DuplicateLayeredPermissionRoute {
  @RequireAdminPermissions(AdminPermission.USERS_VIEW)
  handle(this: void): void {}
}

class DisabledRoute {
  @RequireAdminPermissions(AdminPermission.REPORTS_REOPEN)
  handle(this: void): void {}
}

@RequireAdminPermissions(AdminPermission.POSTS_VIEW)
class ClassProtectedRoute {
  handle(this: void): void {}
}

class MissingMetadataRoute {
  handle(this: void): void {}
}

class MalformedClassMetadataRoute {
  handle(this: void): void {}
}

class MalformedHandlerMetadataRoute {
  handle(this: void): void {}
}

class DuplicateDecoratorMetadataRoute {
  @RequireAdminPermissions(
    AdminPermission.USERS_VIEW,
    AdminPermission.USERS_VIEW,
  )
  handle(this: void): void {}
}

type Principal = Partial<AdminRequestPrincipal>;
type RouteInstance = { handle(this: void): void };
type RouteClass = new () => RouteInstance;

const BASE_PRINCIPAL: AdminRequestPrincipal = Object.freeze({
  adminAccountId: '6a3924c4f5a540da96575f6a',
  id: 'adm_23456789ABCD',
  publicId: 'adm_23456789ABCD',
  username: 'admin.qa',
  displayName: 'Admin QA',
  role: AdminRole.ADMIN,
  sessionId: `ases_${'a'.repeat(36)}`,
  credentialVersion: 0,
  authzVersion: 0,
  permissionVersion: 1,
});

const createPrincipal = (
  role: AdminRole = AdminRole.ADMIN,
  overrides: Partial<AdminRequestPrincipal> = {},
): AdminRequestPrincipal => ({
  ...BASE_PRINCIPAL,
  role,
  ...overrides,
});

const createContext = (
  Route: RouteClass,
  principal?: Principal,
): ExecutionContext => {
  const instance = new Route();

  return {
    getHandler: () => instance.handle,
    getClass: () => Route,
    switchToHttp: () => ({
      getRequest: () => ({ user: principal }),
    }),
  } as unknown as ExecutionContext;
};

const createGuard = (): AdminPermissionGuard =>
  new AdminPermissionGuard(new Reflector());

describe('AdminPermissionGuard', () => {
  it('allows ADMIN with the required operation permission', () => {
    expect(
      createGuard().canActivate(
        createContext(UserViewRoute, createPrincipal()),
      ),
    ).toBe(true);
  });

  it('allows SUPER_ADMIN through inherited ADMIN permission', () => {
    expect(
      createGuard().canActivate(
        createContext(UserViewRoute, createPrincipal(AdminRole.SUPER_ADMIN)),
      ),
    ).toBe(true);
  });

  it('enforces all-of semantics inside method metadata', () => {
    expect(() =>
      createGuard().canActivate(
        createContext(MultiPermissionRoute, createPrincipal()),
      ),
    ).toThrow(ForbiddenException);

    expect(
      createGuard().canActivate(
        createContext(
          MultiPermissionRoute,
          createPrincipal(AdminRole.SUPER_ADMIN),
        ),
      ),
    ).toBe(true);
  });

  it('merges class and handler metadata using all-of semantics', () => {
    expect(() =>
      createGuard().canActivate(
        createContext(LayeredPermissionRoute, createPrincipal()),
      ),
    ).toThrow(ForbiddenException);

    expect(
      createGuard().canActivate(
        createContext(
          LayeredPermissionRoute,
          createPrincipal(AdminRole.SUPER_ADMIN),
        ),
      ),
    ).toBe(true);
  });

  it('accepts duplicate permission across class and method safely', () => {
    expect(
      createGuard().canActivate(
        createContext(DuplicateLayeredPermissionRoute, createPrincipal()),
      ),
    ).toBe(true);
  });

  it('supports class-level metadata without method metadata', () => {
    expect(
      createGuard().canActivate(
        createContext(ClassProtectedRoute, createPrincipal()),
      ),
    ).toBe(true);
  });

  it('denies a route without permission metadata', () => {
    expect(() =>
      createGuard().canActivate(
        createContext(
          MissingMetadataRoute,
          createPrincipal(AdminRole.SUPER_ADMIN),
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  it('returns 401 for a missing or role-only principal', () => {
    expect(() =>
      createGuard().canActivate(createContext(UserViewRoute)),
    ).toThrow(UnauthorizedException);

    expect(() =>
      createGuard().canActivate(
        createContext(UserViewRoute, { role: AdminRole.SUPER_ADMIN }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it.each([
    ['internal id', { adminAccountId: 'not-an-object-id' }],
    ['public id', { publicId: 'adm_other' }],
    ['session id', { sessionId: `ses_${'a'.repeat(36)}` }],
    ['version', { authzVersion: -1 }],
  ])('returns 401 for malformed principal %s', (_label, overrides) => {
    expect(() =>
      createGuard().canActivate(
        createContext(
          UserViewRoute,
          createPrincipal(AdminRole.ADMIN, overrides),
        ),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('denies disabled permissions even to SUPER_ADMIN', () => {
    expect(() =>
      createGuard().canActivate(
        createContext(DisabledRoute, createPrincipal(AdminRole.SUPER_ADMIN)),
      ),
    ).toThrow(ForbiddenException);
  });

  it('denies malformed class metadata independently', () => {
    Reflect.defineMetadata(
      ADMIN_PERMISSIONS_METADATA,
      ['root.all'],
      MalformedClassMetadataRoute,
    );

    expect(() =>
      createGuard().canActivate(
        createContext(
          MalformedClassMetadataRoute,
          createPrincipal(AdminRole.SUPER_ADMIN),
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  it('denies malformed handler metadata independently', () => {
    Reflect.defineMetadata(
      ADMIN_PERMISSIONS_METADATA,
      [],
      MalformedHandlerMetadataRoute.prototype.handle,
    );

    expect(() =>
      createGuard().canActivate(
        createContext(
          MalformedHandlerMetadataRoute,
          createPrincipal(AdminRole.SUPER_ADMIN),
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  it('deduplicates and freezes decorator metadata', () => {
    const metadata = new Reflector().get<readonly AdminPermissionType[]>(
      ADMIN_PERMISSIONS_METADATA,
      DuplicateDecoratorMetadataRoute.prototype.handle,
    );

    expect(metadata).toEqual([AdminPermission.USERS_VIEW]);
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  it('rejects empty and arbitrary decorator permissions', () => {
    expect(() => RequireAdminPermissions()).toThrow(
      'RequireAdminPermissions yêu cầu ít nhất một permission',
    );
    expect(() =>
      RequireAdminPermissions('root.all' as AdminPermissionType),
    ).toThrow('Admin permission metadata không hợp lệ');
  });
});
