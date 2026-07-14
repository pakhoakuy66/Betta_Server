import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  Headers,
  HttpCode,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { FilesInterceptor } from '@nestjs/platform-express';
import { PostsService } from '../services/posts.service';
import { CreatePostDto } from '../dto/create-post.dto';
import { FeedQueryDto, ProfilePostsQueryDto } from '../dto/post-query.dto';

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
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.postsService.createPost(
      req.user._id,
      createPostDto,
      files,
      idempotencyKey,
    );
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

  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Lấy danh sách bài viết trên profile theo username',
  })
  @UseGuards(AuthGuard('jwt'))
  @Get('profile/:username')
  async getProfilePosts(
    @Request() req: AuthenticatedRequest,
    @Param('username') username: string,
    @Query() query: ProfilePostsQueryDto,
  ) {
    return this.postsService.getProfilePosts(req.user._id, username, query);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Ghi nhận lượt chia sẻ/copy link bài viết' })
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @Post(':publicId/share')
  async recordPostShare(
    @Request() req: AuthenticatedRequest,
    @Param('publicId') publicId: string,
  ) {
    return this.postsService.recordPostShare(req.user._id, publicId);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Lấy chi tiết bài viết theo publicId' })
  @UseGuards(AuthGuard('jwt'))
  @Get(':publicId')
  async getPostDetail(
    @Request() req: AuthenticatedRequest,
    @Param('publicId') publicId: string,
  ) {
    return this.postsService.getPostDetail(req.user._id, publicId);
  }

  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Xóa bài viết của chính mình theo publicId' })
  @UseGuards(AuthGuard('jwt'))
  @Delete(':publicId')
  async deletePost(
    @Request() req: AuthenticatedRequest,
    @Param('publicId') publicId: string,
  ) {
    return this.postsService.deletePost(req.user._id, publicId);
  }
}
