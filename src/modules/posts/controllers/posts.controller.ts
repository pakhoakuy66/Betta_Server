import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PostsService } from '../services/posts.service';
import { CreatePostDto } from '../dto/create-post.dto';
import { FeedQueryDto } from '../dto/post-query.dto';

type AuthenticatedRequest = {
  user: {
    _id: string;
  };
};

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

@ApiTags('Posts')
@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Tạo bài viết 24h dạng text và/hoặc ảnh' })
  @ApiConsumes('multipart/form-data')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(
    FilesInterceptor('images', 3, {
      storage: memoryStorage(),
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: 3,
      },
    }),
  )
  @Post()
  async createPost(
    @Request() req: AuthenticatedRequest,
    @Body() createPostDto: CreatePostDto,
    @UploadedFiles() files: UploadFile[] = [],
  ) {
    return this.postsService.createPost(req.user._id, createPostDto, files);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Lấy feed bài viết 24h của mình và người đang follow',
  })
  @UseGuards(AuthGuard('jwt'))
  @Get('feed')
  async getFeed(
    @Request() req: AuthenticatedRequest,
    @Query() query: FeedQueryDto,
  ) {
    return this.postsService.getFeed(req.user._id, query);
  }
}
