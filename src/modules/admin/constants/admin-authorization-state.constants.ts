import { type Provider } from '@nestjs/common';

export const ADMIN_AUTHORIZATION_ACCOUNT_CACHE_TTL_MS = 4_000;
export const ADMIN_AUTHORIZATION_ACCOUNT_CACHE_MAX_ENTRIES = 5_000;

export const ADMIN_AUTHORIZATION_CLOCK = Symbol('ADMIN_AUTHORIZATION_CLOCK');

export type AdminAuthorizationClock = () => number;

export const ADMIN_AUTHORIZATION_CLOCK_PROVIDER: Provider = {
  provide: ADMIN_AUTHORIZATION_CLOCK,
  useValue: (): number => Date.now(),
};
