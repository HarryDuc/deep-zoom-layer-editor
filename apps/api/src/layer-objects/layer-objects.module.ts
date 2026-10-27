import { Module } from '@nestjs/common';
import { LayerObjectsController } from './layer-objects.controller';
import { LayerObjectsService } from './layer-objects.service';
import { ModelsModule } from '../database/models.module';
import { GeometryValidationService } from '../common/validators/geometry-validation.service';

@Module({
  imports: [ModelsModule],
  controllers: [LayerObjectsController],
  providers: [LayerObjectsService, GeometryValidationService],
  exports: [LayerObjectsService, GeometryValidationService],
})
export class LayerObjectsModule {}
