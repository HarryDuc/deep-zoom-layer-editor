import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { ImageProcessingService } from './image-processing.service';
import { DziGeneratorService, DziGeneratorService as Generator } from './dzi-generator.service';
import { OverlayDziService } from './overlay-dzi.service';
import { TaskManagerService } from './task-manager.service';
import { ModelsModule } from '../database/models.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [ModelsModule, StorageModule],
  providers: [
    DziGeneratorService,
    {
      provide: TaskManagerService,
      useFactory: (config: AppConfig): TaskManagerService =>
        new TaskManagerService(config.imageProcessingConcurrency),
      inject: [APP_CONFIG],
    },
    ImageProcessingService,
    OverlayDziService,
  ],
  exports: [ImageProcessingService, TaskManagerService, Generator, OverlayDziService],
})
export class ImageProcessingModule {}
