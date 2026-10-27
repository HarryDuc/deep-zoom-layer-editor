import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { LayersService } from './layers.service';
import { ImageLayer, ImageLayerDocument } from './schemas/image-layer.schema';
import { LayerObject } from '../layer-objects/schemas/layer-object.schema';
import { ImageAsset } from '../images/schemas/image-asset.schema';

const IMAGE_ID = new Types.ObjectId('64b0000000000000000000a1').toString();
const OTHER_IMAGE_ID = new Types.ObjectId('64b0000000000000000000a2').toString();
const LAYER_ID = new Types.ObjectId('64b0000000000000000000b1').toString();

/** Minimal query-chain stub that resolves to a fixed value. */
function queryReturning<T>(value: T) {
  const chain: Record<string, unknown> = {};
  for (const method of ['sort', 'select', 'skip', 'limit']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.exec = jest.fn(async () => value);
  return chain;
}

describe('LayersService', () => {
  let layerModel: {
    find: jest.Mock;
    findOne: jest.Mock;
    findById: jest.Mock;
    create: jest.Mock;
    findByIdAndUpdate: jest.Mock;
    deleteOne: jest.Mock;
    exists: jest.Mock;
  };
  let objectModel: { deleteMany: jest.Mock };
  let imageModel: { exists: jest.Mock };

  let service: LayersService;

  const makeLayer = (overrides: Record<string, unknown> = {}): ImageLayerDocument =>
    ({
      _id: new Types.ObjectId(LAYER_ID),
      imageAssetId: new Types.ObjectId(IMAGE_ID),
      name: 'Layer 1',
      visible: true,
      locked: false,
      zIndex: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      ...overrides,
    }) as unknown as ImageLayerDocument;

  beforeEach(async () => {
    layerModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      // Mongoose query builders expose `.exec()`; the fakes must too.
      deleteOne: jest.fn().mockReturnValue(queryReturning({ deletedCount: 1 })),
      exists: jest.fn(),
    };
    objectModel = {
      deleteMany: jest.fn().mockReturnValue(queryReturning({ deletedCount: 0 })),
    };
    imageModel = { exists: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LayersService,
        { provide: getModelToken(ImageLayer.name), useValue: layerModel },
        { provide: getModelToken(LayerObject.name), useValue: objectModel },
        { provide: getModelToken(ImageAsset.name), useValue: imageModel },
      ],
    }).compile();

    service = moduleRef.get(LayersService);
  });

  /* ---------------------------- image ownership --------------------------- */

  describe('assertImageExists', () => {
    it('rejects a malformed image id', async () => {
      await expect(service.assertImageExists('nope')).rejects.toMatchObject({
        code: 'INVALID_IMAGE_ID',
      });
    });

    it('throws not found when the image does not exist', async () => {
      imageModel.exists.mockReturnValue(queryReturning(null));

      await expect(service.assertImageExists(IMAGE_ID)).rejects.toMatchObject({
        code: 'IMAGE_NOT_FOUND',
      });
    });

    it('returns the image ObjectId when the image exists', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));

      await expect(service.assertImageExists(IMAGE_ID)).resolves.toEqual(
        new Types.ObjectId(IMAGE_ID),
      );
    });
  });

  /* ----------------------------- layer lookups ---------------------------- */

  describe('findLayerById', () => {
    it('rejects a malformed layer id', async () => {
      await expect(service.findLayerById('nope')).rejects.toMatchObject({
        code: 'INVALID_LAYER_ID',
      });
    });

    it('throws not found for an unknown layer', async () => {
      layerModel.findById.mockReturnValue(queryReturning(null));

      await expect(service.findLayerById(LAYER_ID)).rejects.toMatchObject({
        code: 'LAYER_NOT_FOUND',
      });
    });

    it('returns the layer document', async () => {
      const layer = makeLayer();
      layerModel.findById.mockReturnValue(queryReturning(layer));

      await expect(service.findLayerById(LAYER_ID)).resolves.toBe(layer);
    });
  });

  describe('findOwnedLayer', () => {
    it('throws not found when the layer belongs to another image', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      // The ownership filter matches nothing.
      layerModel.findOne.mockReturnValue(queryReturning(null));

      await expect(service.findOwnedLayer(IMAGE_ID, LAYER_ID)).rejects.toMatchObject({
        code: 'LAYER_NOT_FOUND',
      });
    });

    it('returns the layer when it belongs to the image', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
      const layer = makeLayer();
      layerModel.findById.mockReturnValue(queryReturning(layer));
      layerModel.findOne.mockReturnValue(queryReturning(layer));

      await expect(service.findOwnedLayer(IMAGE_ID, LAYER_ID)).resolves.toBe(layer);
    });

    it('rejects a malformed layer id before touching the database', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));

      await expect(service.findOwnedLayer(IMAGE_ID, 'nope')).rejects.toMatchObject({
        code: 'INVALID_LAYER_ID',
      });
      expect(layerModel.findById).not.toHaveBeenCalled();
    });  });

  /* -------------------------------- listing ------------------------------- */

  describe('list', () => {
    it('returns the layers of the image in stacking order', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
      layerModel.find.mockReturnValue(
        queryReturning([makeLayer({ name: 'Bottom' }), makeLayer({ name: 'Top', zIndex: 1 })]),
      );

      const layers = await service.list(IMAGE_ID);

      expect(layers.map((layer) => layer.name)).toEqual(['Bottom', 'Top']);
      expect(layerModel.find).toHaveBeenCalledWith({ imageAssetId: new Types.ObjectId(IMAGE_ID) });
    });
  });

  /* -------------------------------- create -------------------------------- */

  describe('create', () => {
    it('appends the new layer on top of the stack', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
      layerModel.findOne.mockReturnValue(queryReturning({ zIndex: 4 }));
      layerModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeLayer(payload),
      );

      await service.create(IMAGE_ID, { name: '  New layer  ' });

      expect(layerModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New layer', zIndex: 5, visible: true, locked: false }),
      );
    });

    it('starts the stacking order at zero for the first layer', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
      layerModel.findOne.mockReturnValue(queryReturning(null));
      layerModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeLayer(payload),
      );

      await service.create(IMAGE_ID, { name: 'First' });

      expect(layerModel.create).toHaveBeenCalledWith(expect.objectContaining({ zIndex: 0 }));
    });

    it('honours an explicit zIndex', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
      layerModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeLayer(payload),
      );

      await service.create(IMAGE_ID, { name: 'Pinned', zIndex: 7 });

      expect(layerModel.findOne).not.toHaveBeenCalled();
      expect(layerModel.create).toHaveBeenCalledWith(expect.objectContaining({ zIndex: 7 }));
    });

    it('honours explicit visibility and lock flags', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
      // An explicit zIndex skips the "highest layer" lookup entirely.
      layerModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeLayer(payload),
      );

      await service.create(IMAGE_ID, { name: 'Hidden', visible: false, locked: true, zIndex: 3 });

      expect(layerModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ visible: false, locked: true, zIndex: 3 }),
      );
    });
  });

  /* -------------------------------- update -------------------------------- */

  describe('update', () => {
    it('rejects an empty update', async () => {
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));

      await expect(service.update(LAYER_ID, {})).rejects.toMatchObject({
        code: 'EMPTY_UPDATE',
      });
    });

    it('applies the provided fields only', async () => {
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      layerModel.findByIdAndUpdate.mockReturnValue(
        queryReturning(makeLayer({ name: 'Renamed', visible: false })),
      );

      const dto = await service.update(LAYER_ID, { name: '  Renamed  ', visible: false });

      expect(layerModel.findByIdAndUpdate).toHaveBeenCalledWith(
        new Types.ObjectId(LAYER_ID),
        { $set: { name: 'Renamed', visible: false } },
        { new: true, runValidators: true },
      );
      expect(dto.name).toBe('Renamed');
    });

    it('throws not found when the layer disappears during the update', async () => {
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      layerModel.findByIdAndUpdate.mockReturnValue(queryReturning(null));

      await expect(service.update(LAYER_ID, { name: 'Ghost' })).rejects.toMatchObject({
        code: 'LAYER_NOT_FOUND',
      });
    });

    it('scopes the lookup to the owning image when an image id is given', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      layerModel.findOne.mockReturnValue(queryReturning(null));

      await expect(service.update(LAYER_ID, { name: 'X' }, IMAGE_ID)).rejects.toMatchObject({
        code: 'LAYER_NOT_FOUND',
      });
    });
  });

  /* -------------------------------- remove -------------------------------- */

  describe('remove', () => {
    it('deletes the objects that belong to the layer first', async () => {
      const layer = makeLayer();
      layerModel.findById.mockReturnValue(queryReturning(layer));

      await service.remove(LAYER_ID);

      expect(objectModel.deleteMany).toHaveBeenCalledWith({ layerId: layer._id });
      expect(layerModel.deleteOne).toHaveBeenCalledWith({ _id: layer._id });
    });

    it('scopes the lookup to the owning image when an image id is given', async () => {
      imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      layerModel.findOne.mockReturnValue(queryReturning(null));

      await expect(service.remove(LAYER_ID, IMAGE_ID)).rejects.toMatchObject({
        code: 'LAYER_NOT_FOUND',
      });
      expect(layerModel.deleteOne).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------- ownership ------------------------------ */

  describe('assertLayerBelongsToImage', () => {
    it('throws not found when the layer does not belong to the image', async () => {
      layerModel.exists.mockReturnValue(queryReturning(null));

      await expect(
        service.assertLayerBelongsToImage(
          new Types.ObjectId(LAYER_ID),
          new Types.ObjectId(IMAGE_ID),
        ),
      ).rejects.toMatchObject({ code: 'LAYER_NOT_FOUND' });
    });

    it('accepts a layer that belongs to the image', async () => {
      layerModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(LAYER_ID) }));

      await expect(
        service.assertLayerBelongsToImage(
          new Types.ObjectId(LAYER_ID),
          new Types.ObjectId(IMAGE_ID),
        ),
      ).resolves.toBeUndefined();
    });
  });

  /* -------------------------------- mapping ------------------------------- */

  describe('toDto', () => {
    it('maps a layer document to the public DTO', () => {
      const dto = service.toDto(makeLayer());

      expect(dto).toEqual({
        _id: LAYER_ID,
        imageAssetId: IMAGE_ID,
        name: 'Layer 1',
        visible: true,
        locked: false,
        zIndex: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
    });
  });

  it('rejects ids that are not 24-character hex strings', () => {
    expect(() => service.assertObjectId('123', 'INVALID_LAYER_ID')).toThrow();
    expect(() => service.assertObjectId('zz0000000000000000000000', 'INVALID_LAYER_ID')).toThrow();
    expect(() => service.assertObjectId(LAYER_ID, 'INVALID_LAYER_ID')).not.toThrow();
  });

  it('does not leak a layer from another image through findOwnedLayer', async () => {
    imageModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(IMAGE_ID) }));
    layerModel.findById.mockReturnValue(
      queryReturning(makeLayer({ imageAssetId: new Types.ObjectId(OTHER_IMAGE_ID) })),
    );
    layerModel.findOne.mockReturnValue(queryReturning(null));

    await expect(service.findOwnedLayer(IMAGE_ID, LAYER_ID)).rejects.toMatchObject({
      code: 'LAYER_NOT_FOUND',
    });
  });
});
