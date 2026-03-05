import { Module } from '@nestjs/common';
import { PostsService } from './services/posts.service';
import { PostsController } from './controllers/posts.controller';

@Module({
  providers: [PostsService],
  controllers: [PostsController]
})
export class PostsModule {}
