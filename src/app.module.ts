import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { PostsModule } from './modules/posts/posts.module';
import { RecapModule } from './modules/recap/recap.module';
import { StreakModule } from './modules/streak/streak.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { UsersModule } from './modules/users/users.module';
import { RelationshipModule } from './modules/relationshipModule/relationship.module';
import { BlockModule } from './modules/relationshipModule/block.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('DATABASE_URL'),
      }),
      inject: [ConfigService],
    }),
    AuthModule, 
    PostsModule, 
    RecapModule, 
    StreakModule, 
    NotificationsModule, 
    ReportsModule, 
    UploadsModule, 
    UsersModule,
    RelationshipModule,
    BlockModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
