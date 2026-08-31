import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { POST_PUBLIC_ID_PATTERN } from '../../posts/utils/generate-post-public-id';

export class AdminPostPublicIdParamDto {
  @ApiProperty({
    pattern: POST_PUBLIC_ID_PATTERN.source,
    example: 'post_23456789ABCD',
  })
  @IsString()
  @Matches(POST_PUBLIC_ID_PATTERN)
  publicId!: string;
}
