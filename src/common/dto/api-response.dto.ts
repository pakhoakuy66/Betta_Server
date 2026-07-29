import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiSuccessResponseDto {
  @ApiProperty({ example: true })
  success!: true;

  @ApiProperty({
    nullable: true,
    oneOf: [
      { type: 'object', additionalProperties: true },
      { type: 'array', items: {} },
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
    ],
  })
  data!: unknown;

  @ApiPropertyOptional({
    example: 'Thao tác thành công',
  })
  message?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
  })
  meta?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
  })
  pagination?: Record<string, unknown>;
}

export class ApiErrorResponseDto {
  @ApiProperty({ example: false })
  success!: false;

  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'VALIDATION_ERROR' })
  error!: string;

  @ApiProperty({
    oneOf: [
      { type: 'string' },
      {
        type: 'array',
        items: { type: 'string' },
      },
    ],
  })
  message!: string | string[];

  @ApiProperty({
    example: '2026-07-14T10:00:00.000Z',
  })
  timestamp!: string;

  @ApiProperty({
    example: '/api/v1/auth/login',
  })
  path!: string;

  @ApiPropertyOptional({ example: 60 })
  retryAfterSeconds?: number;
}
