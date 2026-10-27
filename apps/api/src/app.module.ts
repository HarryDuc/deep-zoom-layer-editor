import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { APP_CONFIG, AppConfig } from './config/configuration';
import { ConfigModule } from './config/config.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { createMulterOptions } from './common/multer/upload-options';
import { StorageModule } from './storage/storage.module';
import { ImageProcessingModule } from './image-processing/image-processing.module';
import { ImagesModule } from './images/images.module';
import { LayersModule } from './layers/layers.module';
import { LayerObjectsModule } from './layer-objects/layer-objects.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forRootAsync({
      // The URI comes from the same validated config object the rest of the
      // app uses, so a malformed value fails fast at boot.
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        uri: config.mongodbUri,
        serverSelectionTimeoutMS: 8000,
        autoIndex: config.nodeEnv !== 'production',
      }),
    }),
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createMulterOptions(config),
    }),
    StorageModule,
    ImageProcessingModule,
    ImagesModule,
    LayersModule,
    LayerObjectsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule {}
