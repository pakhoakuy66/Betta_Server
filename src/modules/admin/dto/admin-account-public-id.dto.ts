import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { ADMIN_PUBLIC_ID_PATTERN } from '../utils/generate-admin-public-id';

export class AdminAccountPublicIdParamDto {
  @ApiProperty({
    example: 'adm_23456789ABCD',
    pattern: ADMIN_PUBLIC_ID_PATTERN.source,
  })
  @IsString()
  @Matches(ADMIN_PUBLIC_ID_PATTERN)
  publicId!: string;
}
