import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { IMAGE_STATUS, ImageStatus } from '@deep-zoom/shared-types';

export type ImageAssetDocument = HydratedDocument<ImageAsset>;

/**
 * Persistence model for an uploaded image.
 *
 * `storageKey` is server-generated and is the only value used to build
 * filesystem paths. The original filename is kept for display purposes only.
 */
@Schema({ collection: 'image_assets', timestamps: true, versionKey: false })
export class ImageAsset {
  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  name!: string;

  @Prop({ type: String, required: true, maxlength: 255 })
  originalFilename!: string;

  /** Relative path of the stored original, e.g. `originals/<key>.bin`. Internal only. */
  @Prop({ type: String, required: true })
  originalPath!: string;

  /** Server-generated opaque key used for descriptor/tile/overlay folders. */
  @Prop({ type: String, required: true, unique: true, index: true })
  storageKey!: string;

  /** Relative path of the generated descriptor, e.g. `dzi/<key>.dzi`. */
  @Prop({ type: String })
  dziPath?: string;

  @Prop({ type: Number, min: 1 })
  width?: number;

  @Prop({ type: Number, min: 1 })
  height?: number;

  @Prop({ type: Number, required: true, min: 1 })
  fileSize!: number;

  @Prop({ type: String, required: true, maxlength: 100 })
  mimeType!: string;

  @Prop({ type: String, required: true, enum: IMAGE_STATUS, default: 'PROCESSING', index: true })
  status!: ImageStatus;

  @Prop({ type: String, maxlength: 1000 })
  errorMessage?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ImageAssetSchema = SchemaFactory.createForClass(ImageAsset);

ImageAssetSchema.index({ createdAt: -1 });

export function toObjectId(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}
