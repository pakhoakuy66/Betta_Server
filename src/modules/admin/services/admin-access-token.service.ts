import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ADMIN_POLICY, type AdminPolicy } from '../config/admin-policy.config';
import {
  ADMIN_SECRETS,
  AdminSecretPurpose,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import {
  ADMIN_ACCESS_TOKEN_AUDIENCE,
  ADMIN_ACCESS_TOKEN_ISSUER,
  ADMIN_ACCESS_TOKEN_USE,
  ADMIN_JWT_ALGORITHM,
  ADMIN_SESSION_PUBLIC_ID_PATTERN,
} from '../constants/admin-auth-token.constants';
import { type IssueAdminAccessTokenInput } from '../interfaces/admin-access-token.interface';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

@Injectable()
export class AdminAccessTokenService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(ADMIN_SECRETS)
    private readonly adminSecrets: AdminSecrets,
    @Inject(ADMIN_POLICY)
    private readonly adminPolicy: AdminPolicy,
  ) {}

  async issue(input: IssueAdminAccessTokenInput): Promise<string> {
    this.assertInput(input);

    const signingKey = this.adminSecrets.current(
      AdminSecretPurpose.ACCESS_TOKEN_SIGNING,
    );

    return this.jwtService.signAsync(
      {
        tokenUse: ADMIN_ACCESS_TOKEN_USE,
        sid: input.sessionPublicId,
        credentialVersion: input.credentialVersion,
        authzVersion: input.authzVersion,
        permissionVersion: input.permissionVersion,
      },
      {
        secret: signingKey.key,
        algorithm: ADMIN_JWT_ALGORITHM,
        keyid: signingKey.id,
        issuer: ADMIN_ACCESS_TOKEN_ISSUER,
        audience: ADMIN_ACCESS_TOKEN_AUDIENCE,
        subject: input.adminPublicId,
        expiresIn: this.adminPolicy.session.accessTokenTtlSeconds,
      },
    );
  }

  private assertInput(input: IssueAdminAccessTokenInput): void {
    if (
      !isValidAdminPublicId(input.adminPublicId) ||
      !ADMIN_SESSION_PUBLIC_ID_PATTERN.test(input.sessionPublicId) ||
      !isNonNegativeInteger(input.credentialVersion) ||
      !isNonNegativeInteger(input.authzVersion) ||
      !isNonNegativeInteger(input.permissionVersion)
    ) {
      throw new TypeError('Admin access token input không hợp lệ');
    }
  }
}
