import { Module } from '@nestjs/common';
import { LayersController } from './layers.controller';
import { LayersService } from './layers.service';
import { ModelsModule } from '../database/models.module';

@Module({
  imports: [ModelsModule],
  controllers: [LayersController],
  providers: [LayersService],
  exports: [LayersService],
})
export class LayersModule {}
