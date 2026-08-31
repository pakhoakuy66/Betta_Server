import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  ACCESS_SUPPORT_ACCOUNT_IDENTIFIER_MAX_LENGTH,
  ACCESS_SUPPORT_CATEGORIES,
  ACCESS_SUPPORT_CORRELATION_ID_PATTERN,
  ACCESS_SUPPORT_DESCRIPTION_MAX_LENGTH,
  ACCESS_SUPPORT_DESCRIPTION_MIN_LENGTH,
  type AccessSupportCategory,
} from '../constants/access-support.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class AccessSupportRequestDto {
  @IsIn(ACCESS_SUPPORT_CATEGORIES)
  category!: AccessSupportCategory;

  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  contactEmail!: string;

  @Transform(trim)
  @IsString()
  @MinLength(ACCESS_SUPPORT_DESCRIPTION_MIN_LENGTH)
  @MaxLength(ACCESS_SUPPORT_DESCRIPTION_MAX_LENGTH)
  description!: string;

  @Transform(trim)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(ACCESS_SUPPORT_ACCOUNT_IDENTIFIER_MAX_LENGTH)
  accountEmailOrUsername?: string;

  @Transform(trim)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(ACCESS_SUPPORT_CORRELATION_ID_PATTERN)
  correlationId?: string;
}
