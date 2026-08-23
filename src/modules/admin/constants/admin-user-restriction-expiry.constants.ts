import type { Provider } from '@nestjs/common';

export const ADMIN_USER_RESTRICTION_EXPIRY_INTERVAL_MS = 2_000 as const;
export const ADMIN_USER_RESTRICTION_EXPIRY_BATCH_SIZE = 100 as const;
export const ADMIN_USER_RESTRICTION_EXPIRY_CONCURRENCY = 8 as const;

export const ADMIN_USER_RESTRICTION_EXPIRY_CLOCK = Symbol(
  'ADMIN_USER_RESTRICTION_EXPIRY_CLOCK',
);

export type AdminUserRestrictionExpiryClock = () => Date;

export const ADMIN_USER_RESTRICTION_EXPIRY_CLOCK_PROVIDER: Provider = {
  provide: ADMIN_USER_RESTRICTION_EXPIRY_CLOCK,
  useValue: (): Date => new Date(),
};

export const ADMIN_USER_RESTRICTION_EXPIRY_SYSTEM_ACTOR =
  'Betta restriction expiry worker' as const;
export const ADMIN_USER_RESTRICTION_EXPIRY_REASON_CODE =
  'restriction_expired' as const;
export const ADMIN_USER_RESTRICTION_EXPIRY_REASON_NOTE =
  'Temporary suspension expired automatically' as const;
