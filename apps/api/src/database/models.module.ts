import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ImageAsset, ImageAssetSchema } from '../images/schemas/image-asset.schema';
import { OverlayAsset, OverlayAssetSchema } from '../images/schemas/overlay-asset.schema';
import { ImageLayer, ImageLayerSchema } from '../layers/schemas/image-layer.schema';
import { LayerObject, LayerObjectSchema } from '../layer-objects/schemas/layer-object.schema';

/**
 * Registers every Mongoose model once and re-exports `MongooseModule`, so
 * feature modules can inject any model without repeating `forFeature` calls.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ImageAsset.name, schema: ImageAssetSchema },
      { name: OverlayAsset.name, schema: OverlayAssetSchema },
      { name: ImageLayer.name, schema: ImageLayerSchema },
      { name: LayerObject.name, schema: LayerObjectSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class ModelsModule {}
