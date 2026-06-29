import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersService } from './services/users.service';
import { UsersController } from './controllers/users.controller';
import { UploadsModule } from '../uploads/uploads.module';
import { User, UserSchema } from './schemas/user.schema';
import {
  Relationship,
  RelationshipSchema,
} from '../relationshipModule/schemas/relationship.schema';
import { Block, BlockSchema } from '../relationshipModule/schemas/block.schema';

@Module({
  imports: [
    UploadsModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Relationship.name, schema: RelationshipSchema },
      { name: Block.name, schema: BlockSchema },
    ]),
  ],
  exports: [MongooseModule],
  providers: [UsersService],
  controllers: [UsersController],
})
export class UsersModule {}
