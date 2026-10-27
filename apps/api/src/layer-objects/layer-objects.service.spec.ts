import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { LayerObjectsService } from './layer-objects.service';
import { LayerObject, LayerObjectDocument } from './schemas/layer-object.schema';
import { ImageLayer } from '../layers/schemas/image-layer.schema';
import { ImageAsset } from '../images/schemas/image-asset.schema';
import { OverlayAsset } from '../images/schemas/overlay-asset.schema';
import { GeometryValidationService } from '../common/validators/geometry-validation.service';

const IMAGE_ID = new Types.ObjectId('64b0000000000000000000c1').toString();
const LAYER_ID = new Types.ObjectId('64b0000000000000000000c2').toString();
const OBJECT_ID = new Types.ObjectId('64b0000000000000000000c3').toString();
const OVERLAY_ID = new Types.ObjectId('64b0000000000000000000c4').toString();

/** Minimal query-chain stub that resolves to a fixed value. */
function queryReturning<T>(value: T) {
  const chain: Record<string, unknown> = {};
  for (const method of ['sort', 'select', 'skip', 'limit']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.exec = jest.fn(async () => value);
  return chain;
}

describe('LayerObjectsService', () => {
  let objectModel: {
    find: jest.Mock;
    findOne: jest.Mock;
    findById: jest.Mock;
    create: jest.Mock;
    findByIdAndUpdate: jest.Mock;
    deleteOne: jest.Mock;
    countDocuments: jest.Mock;
    bulkWrite: jest.Mock;
  };
  let layerModel: { findById: jest.Mock };
  let imageModel: { findById: jest.Mock };
  let overlayModel: { exists: jest.Mock };

  let service: LayerObjectsService;

  const makeLayer = (): Record<string, unknown> => ({
    _id: new Types.ObjectId(LAYER_ID),
    imageAssetId: new Types.ObjectId(IMAGE_ID),
  });

  const makeImage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    _id: new Types.ObjectId(IMAGE_ID),
    width: 1000,
    height: 800,
    ...overrides,
  });

  const makeObject = (overrides: Record<string, unknown> = {}): LayerObjectDocument =>
    ({
      _id: new Types.ObjectId(OBJECT_ID),
      layerId: new Types.ObjectId(LAYER_ID),
      type: 'RECTANGLE',
      geometry: { x: 0, y: 0, width: 100, height: 100 },
      style: { fill: '#16a34a' },
      metadata: {},
      visible: true,
      zIndex: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      ...overrides,
    }) as unknown as LayerObjectDocument;

  beforeEach(async () => {
    objectModel = {
      find: jest.fn(),
      // Defaults to "no existing object", which makes the implicit zIndex 0.
      findOne: jest.fn().mockReturnValue(queryReturning(null)),
      findById: jest.fn(),
      create: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      deleteOne: jest.fn().mockReturnValue(queryReturning({ deletedCount: 1 })),
      countDocuments: jest.fn(),
      bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    };
    layerModel = { findById: jest.fn() };
    imageModel = { findById: jest.fn() };
    overlayModel = { exists: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LayerObjectsService,
        { provide: getModelToken(LayerObject.name), useValue: objectModel },
        { provide: getModelToken(ImageLayer.name), useValue: layerModel },
        { provide: getModelToken(ImageAsset.name), useValue: imageModel },
        { provide: getModelToken(OverlayAsset.name), useValue: overlayModel },
        GeometryValidationService,
      ],
    }).compile();

    service = moduleRef.get(LayerObjectsService);
  });

  /* -------------------------------- listing ------------------------------- */

  describe('list', () => {
    it('returns the objects of the layer', async () => {
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      objectModel.find.mockReturnValue(queryReturning([makeObject()]));

      const objects = await service.list(LAYER_ID);

      expect(objects).toHaveLength(1);
      expect(objects[0]._id).toBe(OBJECT_ID);
    });

    it('rejects a malformed layer id', async () => {
      await expect(service.list('nope')).rejects.toMatchObject({
        code: 'INVALID_LAYER_ID',
      });
    });

    it('throws not found for an unknown layer', async () => {
      layerModel.findById.mockReturnValue(queryReturning(null));

      await expect(service.list(LAYER_ID)).rejects.toMatchObject({
        code: 'LAYER_NOT_FOUND',
      });
    });
  });

  /* -------------------------------- create -------------------------------- */

  describe('create', () => {
    beforeEach(() => {
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      imageModel.findById.mockReturnValue(queryReturning(makeImage()));
    });

    it('rejects geometry that lies outside the image', async () => {
      await expect(
        service.create(LAYER_ID, {
          type: 'RECTANGLE',
          geometry: { x: 0, y: 0, width: 5000, height: 5000 },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_GEOMETRY' });
    });

    it('rejects a polygon with fewer than three points', async () => {
      await expect(
        service.create(LAYER_ID, {
          type: 'POLYGON',
          geometry: { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_GEOMETRY' });
    });

    it('applies the default style when none is supplied', async () => {
      objectModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeObject(payload),
      );

      await service.create(LAYER_ID, {
        type: 'RECTANGLE',
        geometry: { x: 10, y: 20, width: 100, height: 50 },
      });

      expect(objectModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          style: {
            fill: '#16a34a',
            fillOpacity: 0.2,
            stroke: '#15803d',
            strokeWidth: 2,
            strokeOpacity: 1,
          },
        }),
      );
    });

    it('appends the new object on top of the stack', async () => {
      objectModel.findOne.mockReturnValue(queryReturning({ zIndex: 3 }));
      objectModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeObject(payload),
      );

      await service.create(LAYER_ID, {
        type: 'RECTANGLE',
        geometry: { x: 0, y: 0, width: 10, height: 10 },
      });

      expect(objectModel.create).toHaveBeenCalledWith(expect.objectContaining({ zIndex: 4 }));
    });

    it('starts the stacking order at zero for the first object', async () => {
      objectModel.findOne.mockReturnValue(queryReturning(null));
      objectModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeObject(payload),
      );

      await service.create(LAYER_ID, {
        type: 'RECTANGLE',
        geometry: { x: 0, y: 0, width: 10, height: 10 },
      });

      expect(objectModel.create).toHaveBeenCalledWith(expect.objectContaining({ zIndex: 0 }));
    });

    it('rejects a LABEL without text', async () => {
      await expect(
        service.create(LAYER_ID, {
          type: 'LABEL',
          geometry: { x: 10, y: 10 },
          metadata: { text: '   ' },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_METADATA' });
    });

    it('accepts Vietnamese label text', async () => {
      objectModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeObject(payload),
      );

      await service.create(LAYER_ID, {
        type: 'LABEL',
        geometry: { x: 10, y: 10 },
        metadata: { text: 'Đường Nguyễn Huệ' },
      });

      expect(objectModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { text: 'Đường Nguyễn Huệ' } }),
      );
    });

    it('rejects an IMAGE object whose overlay does not belong to the image', async () => {
      overlayModel.exists.mockReturnValue(queryReturning(null));

      await expect(
        service.create(LAYER_ID, {
          type: 'IMAGE',
          geometry: { x: 0, y: 0, width: 100, height: 100, overlayId: OVERLAY_ID },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_OVERLAY_REFERENCE' });
    });

    it('accepts an IMAGE object that references a valid overlay', async () => {
      overlayModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(OVERLAY_ID) }));
      objectModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeObject(payload),
      );

      await service.create(LAYER_ID, {
        type: 'IMAGE',
        geometry: { x: 0, y: 0, width: 100, height: 100, overlayId: OVERLAY_ID },
      });

      expect(objectModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'IMAGE', style: { opacity: 1 } }),
      );
    });

    it('throws not found when the owning image no longer exists', async () => {
      imageModel.findById.mockReturnValue(queryReturning(null));

      await expect(
        service.create(LAYER_ID, {
          type: 'RECTANGLE',
          geometry: { x: 0, y: 0, width: 10, height: 10 },
        }),
      ).rejects.toMatchObject({ code: 'IMAGE_NOT_FOUND' });
    });
  });

  /* -------------------------------- update -------------------------------- */

  describe('update', () => {
    beforeEach(() => {
      objectModel.findById.mockReturnValue(queryReturning(makeObject()));
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      imageModel.findById.mockReturnValue(queryReturning(makeImage()));
    });

    it('rejects an empty update', async () => {
      await expect(service.update(OBJECT_ID, {})).rejects.toMatchObject({
        code: 'EMPTY_UPDATE',
      });
    });

    it('rejects a malformed object id', async () => {
      await expect(service.update('nope', { visible: true })).rejects.toMatchObject({
        code: 'INVALID_OBJECT_ID',
      });
    });

    it('throws not found for an unknown object', async () => {
      objectModel.findById.mockReturnValue(queryReturning(null));

      await expect(service.update(OBJECT_ID, { visible: true })).rejects.toMatchObject({
        code: 'OBJECT_NOT_FOUND',
      });
    });

    it('updates the visibility flag', async () => {
      objectModel.findByIdAndUpdate.mockReturnValue(queryReturning(makeObject({ visible: false })));

      const dto = await service.update(OBJECT_ID, { visible: false });

      expect(objectModel.findByIdAndUpdate).toHaveBeenCalledWith(
        new Types.ObjectId(OBJECT_ID),
        { $set: { visible: false } },
        { new: true, runValidators: true },
      );
      expect(dto.visible).toBe(false);
    });

    it('validates updated geometry against the image bounds', async () => {
      await expect(
        service.update(OBJECT_ID, { geometry: { x: 0, y: 0, width: 99999, height: 10 } }),
      ).rejects.toMatchObject({ code: 'INVALID_GEOMETRY' });
    });

    it('throws not found when the object disappears during the update', async () => {
      objectModel.findByIdAndUpdate.mockReturnValue(queryReturning(null));

      await expect(service.update(OBJECT_ID, { visible: true })).rejects.toMatchObject({
        code: 'OBJECT_NOT_FOUND',
      });
    });
  });

  /* -------------------------------- remove -------------------------------- */

  describe('remove', () => {
    it('rejects a malformed object id', async () => {
      await expect(service.remove('nope')).rejects.toMatchObject({
        code: 'INVALID_OBJECT_ID',
      });
    });

    it('deletes the object', async () => {
      objectModel.findById.mockReturnValue(queryReturning(makeObject()));

      await service.remove(OBJECT_ID);

      expect(objectModel.deleteOne).toHaveBeenCalledWith({ _id: new Types.ObjectId(OBJECT_ID) });
    });
  });

  /* -------------------------------- reorder ------------------------------- */

  describe('reorder', () => {
    beforeEach(() => {
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
    });

    it('rejects duplicated ids', async () => {
      await expect(service.reorder(LAYER_ID, [OBJECT_ID, OBJECT_ID])).rejects.toMatchObject({
        code: 'DUPLICATE_OBJECT_IDS',
      });
    });

    it('rejects objects that belong to another layer', async () => {
      objectModel.countDocuments.mockReturnValue(queryReturning(1));

      await expect(service.reorder(LAYER_ID, [OBJECT_ID, '64b0000000000000000000d1'])).rejects.toMatchObject(
        { code: 'OBJECT_LAYER_MISMATCH' },
      );
    });

    it('writes the new stacking order', async () => {
      objectModel.countDocuments.mockReturnValue(queryReturning(2));
      objectModel.find.mockReturnValue(queryReturning([makeObject()]));

      await service.reorder(LAYER_ID, [OBJECT_ID, '64b0000000000000000000d1']);

      expect(objectModel.bulkWrite).toHaveBeenCalledWith([
        {
          updateOne: {
            filter: { _id: new Types.ObjectId(OBJECT_ID), layerId: new Types.ObjectId(LAYER_ID) },
            update: { $set: { zIndex: 0 } },
          },
        },
        {
          updateOne: {
            filter: {
              _id: new Types.ObjectId('64b0000000000000000000d1'),
              layerId: new Types.ObjectId(LAYER_ID),
            },
            update: { $set: { zIndex: 1 } },
          },
        },
      ]);
    });
  });

  /* ---------------------------- style handling --------------------------- */

  describe('style normalization', () => {
    beforeEach(() => {
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      imageModel.findById.mockReturnValue(queryReturning(makeImage()));
      objectModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeObject(payload),
      );
    });

    const createWithStyle = async (type: string, style: unknown) =>
      service.create(LAYER_ID, {
        type: type as 'RECTANGLE',
        geometry:
          type === 'LABEL'
            ? { x: 10, y: 10 }
            : type === 'POINT'
              ? { x: 10, y: 10 }
              : { x: 0, y: 0, width: 10, height: 10 },
        style: style as Record<string, unknown>,
        metadata: type === 'LABEL' ? { text: 'Nhãn' } : undefined,
      });

    it('rejects a non-object style', async () => {
      await expect(createWithStyle('RECTANGLE', 'red')).rejects.toMatchObject({
        code: 'INVALID_STYLE',
      });
    });

    it('rejects an array style', async () => {
      await expect(createWithStyle('RECTANGLE', [])).rejects.toMatchObject({
        code: 'INVALID_STYLE',
      });
    });

    it('keeps a valid hex colour', async () => {
      await createWithStyle('RECTANGLE', { fill: '#ff0000' });

      expect(objectModel.create.mock.calls[0][0].style.fill).toBe('#ff0000');
    });

    it('keeps a valid rgb() colour', async () => {
      await createWithStyle('RECTANGLE', { fill: 'rgba(1, 2, 3, 0.5)' });

      expect(objectModel.create.mock.calls[0][0].style.fill).toBe('rgba(1, 2, 3, 0.5)');
    });

    it('falls back to the default for an unsupported colour format', async () => {
      await createWithStyle('RECTANGLE', { fill: 'not-a-colour' });

      expect(objectModel.create.mock.calls[0][0].style.fill).toBe('#16a34a');
    });

    it('clamps opacity values into the 0..1 range', async () => {
      await createWithStyle('RECTANGLE', { fillOpacity: 5, strokeOpacity: -3 });

      const style = objectModel.create.mock.calls[0][0].style;
      expect(style.fillOpacity).toBe(1);
      expect(style.strokeOpacity).toBe(0);
    });

    it('ignores non-numeric opacity values', async () => {
      await createWithStyle('RECTANGLE', { fillOpacity: 'lots' });

      expect(objectModel.create.mock.calls[0][0].style.fillOpacity).toBe(0.2);
    });

    it('clamps the point radius into a sane range', async () => {
      await createWithStyle('POINT', { radius: 9999 });

      expect(objectModel.create.mock.calls[0][0].style.radius).toBe(500);
    });

    it('clamps the label font size', async () => {
      await createWithStyle('LABEL', { fontSize: 5000 });

      expect(objectModel.create.mock.calls[0][0].style.fontSize).toBe(512);
    });

    it('clamps the image overlay opacity', async () => {
      overlayModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(OVERLAY_ID) }));

      await service.create(LAYER_ID, {
        type: 'IMAGE',
        geometry: { x: 0, y: 0, width: 10, height: 10, overlayId: OVERLAY_ID },
        style: { opacity: 2 },
      });

      expect(objectModel.create.mock.calls[0][0].style.opacity).toBe(1);
    });
  });

  /* -------------------------- metadata handling ------------------------- */

  describe('metadata normalization', () => {
    beforeEach(() => {
      layerModel.findById.mockReturnValue(queryReturning(makeLayer()));
      imageModel.findById.mockReturnValue(queryReturning(makeImage()));
      objectModel.create.mockImplementation(async (payload: Record<string, unknown>) =>
        makeObject(payload),
      );
    });

    it('rejects non-object metadata', async () => {
      await expect(
        service.create(LAYER_ID, {
          type: 'RECTANGLE',
          geometry: { x: 0, y: 0, width: 10, height: 10 },
          metadata: 'hello' as unknown as Record<string, unknown>,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_METADATA' });
    });

    it('trims the name and description', async () => {
      await service.create(LAYER_ID, {
        type: 'RECTANGLE',
        geometry: { x: 0, y: 0, width: 10, height: 10 },
        metadata: { name: '  Street  ', description: '  Main road  ' },
      });

      expect(objectModel.create.mock.calls[0][0].metadata).toEqual({
        name: 'Street',
        description: 'Main road',
      });
    });

    it('truncates a very long label text', async () => {
      await service.create(LAYER_ID, {
        type: 'LABEL',
        geometry: { x: 10, y: 10 },
        metadata: { text: 'a'.repeat(900) },
      });

      expect(objectModel.create.mock.calls[0][0].metadata.text).toHaveLength(500);
    });

    it('omits absent optional metadata keys', async () => {
      await service.create(LAYER_ID, {
        type: 'RECTANGLE',
        geometry: { x: 0, y: 0, width: 10, height: 10 },
        metadata: {},
      });

      expect(objectModel.create.mock.calls[0][0].metadata).toEqual({});
    });
  });

  /* -------------------------------- mapping ------------------------------- */

  describe('toDto', () => {
    it('maps an object document to the public DTO', () => {
      const dto = service.toDto(makeObject());

      expect(dto).toEqual({
        _id: OBJECT_ID,
        layerId: LAYER_ID,
        type: 'RECTANGLE',
        geometry: { x: 0, y: 0, width: 100, height: 100 },
        style: { fill: '#16a34a' },
        metadata: {},
        visible: true,
        zIndex: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
    });
  });
});
