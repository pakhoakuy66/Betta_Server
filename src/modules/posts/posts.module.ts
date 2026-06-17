import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PostsService } from './services/posts.service';
import { PostsController } from './controllers/posts.controller';
import { Post, PostSchema } from './schemas/post.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UploadsModule } from '../uploads/uploads.module';
import {
  Relationship,
  RelationshipSchema,
} from '../relationshipModule/schemas/relationship.schema';
import { Block, BlockSchema } from '../relationshipModule/schemas/block.schema';

@Module({
  imports: [
    UploadsModule,
    MongooseModule.forFeature([
      { name: Post.name, schema: PostSchema },
      { name: User.name, schema: UserSchema },
      { name: Relationship.name, schema: RelationshipSchema },
      { name: Block.name, schema: BlockSchema },
    ]),
  ],
  providers: [PostsService],
  controllers: [PostsController],
})
export class PostsModule {}
