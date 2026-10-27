import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';
import { ModelsModule } from '../database/models.module';
import { StorageModule } from '../storage/storage.module';
import { ImageProcessingModule } from '../image-processing/image-processing.module';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { createMulterOptions } from '../common/multer/upload-options';

@Module({
  imports: [
    ModelsModule,
    StorageModule,
    ImageProcessingModule,
    // FileInterceptor resolves its base options from this module's injector, so
    // the upload limits/temp directory must be registered here.
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createMulterOptions(config),
    }),
  ],
  controllers: [ImagesController],
  providers: [ImagesService],
  exports: [ImagesService],
})
export class ImagesModule {}
