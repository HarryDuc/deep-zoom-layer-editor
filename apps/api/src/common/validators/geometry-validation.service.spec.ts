import {
  GeometryValidationError,
  GeometryValidationService,
} from './geometry-validation.service';

describe('GeometryValidationService', () => {
  const service = new GeometryValidationService();
  const bounds = { width: 1000, height: 800 };

  describe('POLYGON', () => {
    it('normalizes a valid polygon to known keys only', () => {
      const result = service.parse(
        'POLYGON',
        {
          points: [
            { x: 10, y: 20 },
            { x: 30, y: 20 },
            { x: 30, y: 40 },
          ],
        },
        bounds,
      );

      expect(result).toEqual({
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 20 },
          { x: 30, y: 40 },
        ],
      });
    });

    it('rejects a polygon with fewer than three points', () => {
      expect(() =>
        service.parse(
          'POLYGON',
          {
            points: [
              { x: 1, y: 1 },
              { x: 2, y: 2 },
            ],
          },
          bounds,
        ),
      ).toThrow(GeometryValidationError);
    });

    it('rejects unknown properties inside points', () => {
      expect(() =>
        service.parse(
          'POLYGON',
          {
            points: [
              { x: 1, y: 1, z: 5 },
              { x: 2, y: 2 },
              { x: 3, y: 3 },
            ],
          },
          bounds,
        ),
      ).toThrow(/unsupported property "z"/);
    });

    it('rejects negative coordinates', () => {
      expect(() =>
        service.parse(
          'POLYGON',
          {
            points: [
              { x: -1, y: 0 },
              { x: 2, y: 2 },
              { x: 3, y: 3 },
            ],
          },
          bounds,
        ),
      ).toThrow(/must be greater than or equal to 0/);
    });

    it('rejects a polygon that extends past the image bounds', () => {
      expect(() =>
        service.parse(
          'POLYGON',
          {
            points: [
              { x: 10, y: 10 },
              { x: 5000, y: 10 },
              { x: 5000, y: 5000 },
            ],
          },
          bounds,
        ),
      ).toThrow(/outside the image bounds/);
    });
  });

  describe('RECTANGLE', () => {
    it('accepts a positive rectangle inside the image', () => {
      const result = service.parse('RECTANGLE', { x: 5, y: 6, width: 100, height: 50 }, bounds);
      expect(result).toEqual({ x: 5, y: 6, width: 100, height: 50 });
    });

    it('rejects zero-size rectangles', () => {
      expect(() =>
        service.parse('RECTANGLE', { x: 5, y: 6, width: 0, height: 50 }, bounds),
      ).toThrow(/must be greater than 0/);
    });

    it('rejects rectangles whose far corner leaves the image', () => {
      expect(() =>
        service.parse('RECTANGLE', { x: 950, y: 10, width: 200, height: 50 }, bounds),
      ).toThrow(/extends past the image bounds/);
    });

    it('rejects non-numeric width', () => {
      expect(() =>
        service.parse('RECTANGLE', { x: 5, y: 6, width: '100', height: 50 }, bounds),
      ).toThrow(/must be a finite number/);
    });
  });

  describe('POINT and LABEL', () => {
    it('accepts a point inside the image', () => {
      expect(service.parse('POINT', { x: 100, y: 200 }, bounds)).toEqual({ x: 100, y: 200 });
    });

    it('rejects a point outside the image', () => {
      expect(() => service.parse('POINT', { x: 5000, y: 200 }, bounds)).toThrow(
        /outside the image bounds/,
      );
    });

    it('validates LABEL geometry like a point', () => {
      expect(service.parse('LABEL', { x: 1, y: 2 }, bounds)).toEqual({ x: 1, y: 2 });
    });
  });

  describe('IMAGE overlay', () => {
    const overlayId = '507f1f77bcf86cd799439011';

    it('accepts an overlay geometry with a valid ObjectId', () => {
      const result = service.parse(
        'IMAGE',
        { x: 10, y: 10, width: 100, height: 100, overlayId },
        bounds,
      );
      expect(result).toEqual({ x: 10, y: 10, width: 100, height: 100, overlayId });
    });

    it('rejects a malformed overlayId', () => {
      expect(() =>
        service.parse('IMAGE', { x: 10, y: 10, width: 100, height: 100, overlayId: 'nope' }, bounds),
      ).toThrow(/valid ObjectId/);
    });
  });

  describe('shape guards', () => {
    it('rejects non-object geometry', () => {
      expect(() => service.parse('POINT', 'not-an-object')).toThrow(/must be an object/);
    });

    it('rejects arrays as geometry', () => {
      expect(() => service.parse('POINT', [1, 2])).toThrow(/must be an object/);
    });

    it('rejects unsupported object types', () => {
      expect(() => service.parse('TRIANGLE' as never, { x: 1, y: 2 })).toThrow(
        /Unsupported object type/,
      );
    });

    it('does not bounds-check when the image size is unknown', () => {
      expect(service.parse('POINT', { x: 999_999, y: 1 })).toEqual({ x: 999_999, y: 1 });
    });
  });
});
