import { customAlphabet } from 'nanoid';

export const SPONSORED_POST_COLLECTION = 'sponsored_posts';
export const SPONSORED_DAY_MS = 86_400_000;
export const SPONSORED_PUBLIC_ID_PATTERN =
  /^spn_[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{16}$/;
const generateId = customAlphabet(
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  16,
);
export const generateSponsoredPublicId = (): string => `spn_${generateId()}`;
export const SPONSORED_CLOCK = Symbol('SPONSORED_CLOCK');

export enum SponsoredPostStatus {
  DRAFT = 'draft',
  SCHEDULED = 'scheduled',
  ACTIVE = 'active',
  PAUSED = 'paused',
  EXPIRED = 'expired',
  DELETED = 'deleted',
}

export enum SponsoredAssetHealth {
  UNKNOWN = 'unknown',
  HEALTHY = 'healthy',
  MISSING = 'missing',
  CORRUPT = 'corrupt',
}

export enum SponsoredTransition {
  SCHEDULE = 'schedule',
  RETURN_TO_DRAFT = 'return_to_draft',
  ACTIVATE = 'activate',
  PAUSE = 'pause',
  RESUME = 'resume',
  EXPIRE = 'expire',
  DELETE = 'delete',
  RESTORE = 'restore',
}

export const SPONSORED_INDEXES = Object.freeze({
  publicId: 'sponsored_public_id_unique',
  list: 'sponsored_created_public_id',
  statusList: 'sponsored_status_created_public_id',
  start: 'sponsored_status_start_public_id',
  end: 'sponsored_status_end_public_id',
});
