import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Block, BlockSchema } from './schemas/block.schema';
import {
  Relationship,
  RelationshipSchema,
} from './schemas/relationship.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { BlockController } from './controllers/block.controller';
import { BlockService } from './services/block.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Block.name, schema: BlockSchema },
      { name: Relationship.name, schema: RelationshipSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [BlockController],
  providers: [BlockService],
})
export class BlockModule {}
