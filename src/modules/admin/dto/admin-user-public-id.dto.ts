import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { ADMIN_USER_PUBLIC_ID_PATTERN } from '../constants/admin-user-query.constants';

export class AdminUserPublicIdParamDto {
  @ApiProperty({
    example: 'usr_23456789AB',
    pattern: ADMIN_USER_PUBLIC_ID_PATTERN.source,
  })
  @IsString()
  @Matches(ADMIN_USER_PUBLIC_ID_PATTERN)
  publicId!: string;
}
