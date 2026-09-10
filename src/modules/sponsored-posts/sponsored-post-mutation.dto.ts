import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';
import { ADMIN_AUDIT_CORRELATION_ID_PATTERN } from '../admin/constants/admin-audit.constants';
import {
  IsInt,
  IsISO8601,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ADMIN_AUDIT_REASON_CODE_PATTERN } from '../admin/constants/admin-audit.constants';

/** Strict JSON: numeric versions; no implicit conversion and no client media references. */
export class SponsoredMutationReasonDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @Matches(ADMIN_AUDIT_CORRELATION_ID_PATTERN)
  correlationId?: string;

  @IsString()
  @Matches(ADMIN_AUDIT_REASON_CODE_PATTERN)
  reasonCode!: string;
}
export class CreateSponsoredPostDto extends SponsoredMutationReasonDto {
  @IsString() @MaxLength(2500) content!: string;
  @IsString() @MinLength(1) @MaxLength(80) cta!: string;
  @IsString() @MaxLength(2048) destinationUrl!: string;
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u)
  @IsISO8601({ strict: true })
  startAt!: string;
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u)
  @IsISO8601({ strict: true })
  endAt!: string;
}
export class UpdateSponsoredPostDto extends CreateSponsoredPostDto {
  @IsInt() @Min(0) @Max(99999) expectedVersion!: number;
}
export class SponsoredVersionMutationDto extends SponsoredMutationReasonDto {
  @IsInt() @Min(0) @Max(99999) expectedVersion!: number;
}
