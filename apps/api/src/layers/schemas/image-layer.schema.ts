import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ImageLayerDocument = HydratedDocument<ImageLayer>;

@Schema({ collection: 'image_layers', timestamps: true, versionKey: false })
export class ImageLayer {
  @Prop({ type: Types.ObjectId, ref: 'ImageAsset', required: true, index: true })
  imageAssetId!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, minlength: 1, maxlength: 120 })
  name!: string;

  @Prop({ type: Boolean, required: true, default: true })
  visible!: boolean;

  @Prop({ type: Boolean, required: true, default: false })
  locked!: boolean;

  @Prop({ type: Number, required: true, default: 0, min: 0, max: 100000 })
  zIndex!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ImageLayerSchema = SchemaFactory.createForClass(ImageLayer);

ImageLayerSchema.index({ imageAssetId: 1, zIndex: 1 });
