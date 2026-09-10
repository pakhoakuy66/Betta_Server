import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  SPONSORED_PUBLIC_ID_PATTERN,
  SponsoredPostStatus,
} from './sponsored-post.constants';

export enum SponsoredSortField {
  CREATED = 'createdAt',
  START = 'startAt',
  END = 'endAt',
}
export enum SponsoredSortOrder {
  ASC = 'asc',
  DESC = 'desc',
}
const integer = ({ value }: { value: unknown }): number =>
  typeof value === 'string' && /^(0|[1-9]\d{0,5})$/u.test(value)
    ? Number(value)
    : Number.NaN;

export class SponsoredPostQueryDto {
  @Transform(integer) @IsInt() @Min(1) @Max(10001) page = 1;
  @Transform(integer) @IsInt() @Min(1) @Max(100) limit = 20;
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsEnum(SponsoredPostStatus)
  status?: SponsoredPostStatus;
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @Matches(SPONSORED_PUBLIC_ID_PATTERN)
  publicId?: string;
  @IsEnum(SponsoredSortField) sortBy: SponsoredSortField =
    SponsoredSortField.CREATED;
  @IsEnum(SponsoredSortOrder) order: SponsoredSortOrder =
    SponsoredSortOrder.DESC;
  // Inclusive UTC interval on sortBy; range and sort use the same index.
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u)
  @IsISO8601({ strict: true })
  from?: string;
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u)
  @IsISO8601({ strict: true })
  to?: string;
}

export class SponsoredPostQueryParams {
  @IsString() @Matches(SPONSORED_PUBLIC_ID_PATTERN) publicId!: string;
}
