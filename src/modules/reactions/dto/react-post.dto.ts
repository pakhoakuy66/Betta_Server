import { IsEnum, IsOptional } from 'class-validator';
import { ReactionType } from '../schemas/reaction.schema';

export class ReactPostDto {
  @IsOptional()
  @IsEnum(ReactionType, {
    message: 'Loại reaction không hợp lệ',
  })
  emojiType?: ReactionType;
}
