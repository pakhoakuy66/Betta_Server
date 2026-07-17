import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]{16,60}$/;

export class ListAuthSessionsQueryDto {
  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({
    default: 20,
    minimum: 1,
    maximum: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

export class RevokeAuthSessionParamsDto {
  @ApiProperty({
    example: 'ses_550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @Matches(SESSION_ID_PATTERN, {
    message: 'Session ID không hợp lệ',
  })
  sessionId!: string;
}

export class PublicAuthSessionResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'Chrome trên Windows' })
  deviceLabel!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  lastUsedAt!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;

  @ApiProperty()
  isCurrent!: boolean;
}

export class AuthSessionPaginationResponseDto {
  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class AuthSessionListResponseDto {
  @ApiProperty({ example: true })
  success!: true;

  @ApiProperty({ type: [PublicAuthSessionResponseDto] })
  data!: PublicAuthSessionResponseDto[];

  @ApiProperty({ type: AuthSessionPaginationResponseDto })
  pagination!: AuthSessionPaginationResponseDto;
}
