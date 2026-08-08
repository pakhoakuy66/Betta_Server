import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { PassportStrategy } from '@nestjs/passport';
import { type Model, Types } from 'mongoose';
import { ExtractJwt, Strategy, type SecretOrKeyProvider } from 'passport-jwt';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import {
  ADMIN_SECRETS,
  AdminSecretPurpose,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_ACCESS_TOKEN_AUDIENCE,
  ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  ADMIN_ACCESS_TOKEN_ISSUER,
  ADMIN_ACCESS_TOKEN_USE,
  ADMIN_AUTHENTICATION_FAILED_MESSAGE,
  ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE,
  ADMIN_JWT_ALGORITHM,
  ADMIN_JWT_STRATEGY,
  ADMIN_SESSION_PUBLIC_ID_PATTERN,
} from '../constants/admin-auth-token.constants';
import { type AdminAccessTokenClaims } from '../interfaces/admin-access-token.interface';
import { type AdminRequestPrincipal } from '../types/admin-authenticated-request';
import { AdminAccount } from '../schemas/admin-account.schema';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';

type UnknownRecord = Record<string, unknown>;

type AdminPrincipalAccount = {
  _id: Types.ObjectId;
  publicId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  credentialVersion: number;
  authzVersion: number;
  permissionVersion: number;
};

const JWT_HEADER_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const JWT_HEADER_KEYS = new Set(['alg', 'typ', 'kid']);
const ADMIN_ACCESS_CLAIM_KEYS = new Set([
  'tokenUse',
  'sub',
  'sid',
  'credentialVersion',
  'authzVersion',
  'permissionVersion',
  'iss',
  'aud',
  'iat',
  'exp',
]);

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export const resolveAdminAccessTokenVerificationKey = (
  rawToken: unknown,
  adminSecrets: AdminSecrets,
): Buffer => {
  if (typeof rawToken !== 'string') {
    throw new Error(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
  }

  const segments = rawToken.split('.');
  const encodedHeader = segments[0];

  if (
    segments.length !== 3 ||
    !encodedHeader ||
    !JWT_HEADER_SEGMENT_PATTERN.test(encodedHeader)
  ) {
    throw new Error(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
  }

  let header: unknown;

  try {
    const decoded = Buffer.from(encodedHeader, 'base64url');

    if (decoded.toString('base64url') !== encodedHeader) {
      throw new Error('Non-canonical JWT header');
    }

    header = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
  }

  if (
    !isRecord(header) ||
    !hasOnlyKeys(header, JWT_HEADER_KEYS) ||
    header.alg !== ADMIN_JWT_ALGORITHM ||
    header.typ !== 'JWT' ||
    typeof header.kid !== 'string'
  ) {
    throw new Error(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
  }

  try {
    return adminSecrets.resolve(
      AdminSecretPurpose.ACCESS_TOKEN_SIGNING,
      header.kid,
    ).key;
  } catch {
    throw new Error(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
  }
};

export const createAdminSecretOrKeyProvider =
  (adminSecrets: AdminSecrets): SecretOrKeyProvider =>
  (_request, rawToken, done): void => {
    try {
      done(
        null,
        resolveAdminAccessTokenVerificationKey(rawToken, adminSecrets),
      );
    } catch {
      done(new Error(ADMIN_AUTHENTICATION_FAILED_MESSAGE));
    }
  };

const isValidClaims = (
  payload: unknown,
  maximumTtlSeconds: number,
): payload is AdminAccessTokenClaims => {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ADMIN_ACCESS_CLAIM_KEYS)) {
    return false;
  }

  if (
    payload.tokenUse !== ADMIN_ACCESS_TOKEN_USE ||
    !isValidAdminPublicId(payload.sub) ||
    typeof payload.sid !== 'string' ||
    !ADMIN_SESSION_PUBLIC_ID_PATTERN.test(payload.sid) ||
    !isNonNegativeInteger(payload.credentialVersion) ||
    !isNonNegativeInteger(payload.authzVersion) ||
    !isNonNegativeInteger(payload.permissionVersion) ||
    payload.iss !== ADMIN_ACCESS_TOKEN_ISSUER ||
    payload.aud !== ADMIN_ACCESS_TOKEN_AUDIENCE ||
    !isNonNegativeInteger(payload.iat) ||
    !isNonNegativeInteger(payload.exp)
  ) {
    return false;
  }

  const lifetime = payload.exp - payload.iat;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return (
    payload.iat <= nowSeconds + ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS &&
    lifetime > 0 &&
    lifetime <= maximumTtlSeconds
  );
};

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(
  Strategy,
  ADMIN_JWT_STRATEGY,
) {
  constructor(
    @Inject(ADMIN_SECRETS) adminSecrets: AdminSecrets,
    @Inject(ADMIN_POLICY) private readonly adminPolicy: AdminPolicy,
    @InjectModel(AdminAccount.name)
    private readonly adminAccountModel: Model<AdminAccount>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: createAdminSecretOrKeyProvider(adminSecrets),
      issuer: ADMIN_ACCESS_TOKEN_ISSUER,
      audience: ADMIN_ACCESS_TOKEN_AUDIENCE,
      algorithms: [ADMIN_JWT_ALGORITHM],
      jsonWebTokenOptions: {
        clockTolerance: ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
      },
    });
  }

  async validate(payload: unknown): Promise<AdminRequestPrincipal> {
    if (
      !isValidClaims(payload, this.adminPolicy.session.accessTokenTtlSeconds)
    ) {
      throw this.unauthorized();
    }

    let account: AdminPrincipalAccount | null;

    try {
      account = await this.adminAccountModel
        .findOne({
          publicId: payload.sub,
          status: AdminAccountStatus.ACTIVE,
          deletedAt: null,
          mustChangePassword: false,
          mfaStatus: AdminMfaStatus.ACTIVE,
        })
        .select(
          '_id publicId username displayName role ' +
            '+credentialVersion +authzVersion +permissionVersion',
        )
        .lean<AdminPrincipalAccount | null>()
        .exec();
    } catch (error: unknown) {
      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE,
        );
      }

      throw error;
    }

    if (
      !account ||
      !(account._id instanceof Types.ObjectId) ||
      account.publicId !== payload.sub ||
      (account.role !== AdminRole.ADMIN &&
        account.role !== AdminRole.SUPER_ADMIN) ||
      account.credentialVersion !== payload.credentialVersion ||
      account.authzVersion !== payload.authzVersion ||
      account.permissionVersion !== payload.permissionVersion
    ) {
      throw this.unauthorized();
    }

    return Object.freeze({
      adminAccountId: account._id.toHexString(),
      id: account.publicId,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      sessionId: payload.sid,
      credentialVersion: account.credentialVersion,
      authzVersion: account.authzVersion,
      permissionVersion: account.permissionVersion,
    });
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException(ADMIN_AUTHENTICATION_FAILED_MESSAGE);
  }
}
