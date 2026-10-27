import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ImageAsset } from '@deep-zoom/shared-types';
import ImageViewerPage from './page';
import * as apiClient from '@/services/api-client';
import { ApiError } from '@/lib/http';

/**
 * Tests for the image viewer page.
 *
 * The page owns a small state machine: it loads the asset, shows a processing
 * screen and polls until the DZI pyramid is ready, or reports a failure. The
 * editor itself is stubbed because it is covered by its own test file.
 */

const mockParams: { imageId: string } = { imageId: 'image-1' };

vi.mock('next/navigation', () => ({
  useParams: () => mockParams,
}));

vi.mock('@/components/layer-editor/layer-editor', () => ({
  LayerEditor: ({ image }: { image: ImageAsset }) => (
    <div data-testid="layer-editor">{image.name}</div>
  ),
}));

vi.mock('@/services/api-client', () => ({
  fetchImage: vi.fn(),
  fetchImageStatus: vi.fn(),
}));

const mocked = vi.mocked(apiClient);

function makeImage(overrides: Partial<ImageAsset> = {}): ImageAsset {
  return {
    _id: 'image-1',
    name: 'Bản đồ vệ tinh',
    originalFilename: 'map.jpg',
    width: 1000,
    height: 800,
    fileSize: 2048,
    mimeType: 'image/jpeg',
    status: 'COMPLETED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ImageViewerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocked.fetchImage.mockResolvedValue(makeImage());
    mocked.fetchImageStatus.mockResolvedValue({
      imageId: 'image-1',
      status: 'COMPLETED',
      width: 1000,
      height: 800,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the loading state while the asset is fetched', () => {
    mocked.fetchImage.mockReturnValue(new Promise(() => undefined));

    render(<ImageViewerPage />);

    expect(screen.getByTestId('page-loading')).toBeInTheDocument();
  });

  it('renders the editor for a completed image', async () => {
    render(<ImageViewerPage />);

    await waitFor(() => expect(screen.getByTestId('layer-editor')).toBeInTheDocument());
    expect(mocked.fetchImage).toHaveBeenCalledWith('image-1');
  });

  it('shows the processing screen while the pyramid is being built', async () => {
    mocked.fetchImage.mockResolvedValue(makeImage({ status: 'PROCESSING' }));

    render(<ImageViewerPage />);

    await waitFor(() => expect(screen.getByTestId('page-processing')).toBeInTheDocument());
  });

  it('shows the failure screen with the stored reason', async () => {
    mocked.fetchImage.mockResolvedValue(
      makeImage({ status: 'FAILED', errorMessage: 'Tệp không đọc được' }),
    );

    render(<ImageViewerPage />);

    await waitFor(() =>
      expect(screen.getByTestId('page-processing-failed')).toHaveTextContent('Tệp không đọc được'),
    );
  });

  it('shows the missing screen when the asset does not exist', async () => {
    mocked.fetchImage.mockRejectedValue(new ApiError(404, 'IMAGE_NOT_FOUND', 'Không tìm thấy'));

    render(<ImageViewerPage />);

    await waitFor(() => expect(screen.getByTestId('page-missing')).toBeInTheDocument());
  });

  it('shows the error screen for any other API failure', async () => {
    mocked.fetchImage.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'Máy chủ lỗi'));

    render(<ImageViewerPage />);

    await waitFor(() => expect(screen.getByTestId('page-error')).toHaveTextContent('Máy chủ lỗi'));
  });

  it('shows a generic message for a non-API failure', async () => {
    mocked.fetchImage.mockRejectedValue(new Error('offline'));

    render(<ImageViewerPage />);

    await waitFor(() =>
      expect(screen.getByTestId('page-error')).toHaveTextContent('Không thể tải thông tin ảnh.'),
    );
  });

  it('polls the status until the processing finishes', async () => {
    mocked.fetchImage.mockResolvedValue(makeImage({ status: 'PROCESSING' }));

    render(<ImageViewerPage />);

    await waitFor(() => expect(screen.getByTestId('page-processing')).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(1600);

    await waitFor(() => expect(mocked.fetchImageStatus).toHaveBeenCalledWith('image-1'));
  });

  it('switches to the editor once the status reports completion', async () => {
    mocked.fetchImage.mockResolvedValue(makeImage({ status: 'PROCESSING' }));
    mocked.fetchImageStatus.mockResolvedValue({
      imageId: 'image-1',
      status: 'COMPLETED',
      width: 1000,
      height: 800,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    render(<ImageViewerPage />);

    await waitFor(() => expect(screen.getByTestId('page-processing')).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(1600);

    // The asset is re-fetched so the editor receives the final dimensions.
    await waitFor(() => expect(screen.getByTestId('layer-editor')).toBeInTheDocument());
    expect(mocked.fetchImage).toHaveBeenCalledTimes(2);
  });

  it('stops polling and reports the failure when the status reports an error', async () => {
    mocked.fetchImage.mockResolvedValue(makeImage({ status: 'PROCESSING' }));
    mocked.fetchImageStatus.mockResolvedValue({
      imageId: 'image-1',
      status: 'FAILED',
      errorMessage: 'Vượt giới hạn pixel',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    render(<ImageViewerPage />);

    await waitFor(() => expect(screen.getByTestId('page-processing')).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(1600);

    await waitFor(() =>
      expect(screen.getByTestId('page-processing-failed')).toHaveTextContent('Vượt giới hạn pixel'),
    );
  });

  it('keeps polling after a transient network error', async () => {
    mocked.fetchImage.mockResolvedValue(makeImage({ status: 'PROCESSING' }));
    mocked.fetchImageStatus
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValue({
        imageId: 'image-1',
        status: 'COMPLETED',
        width: 1000,
        height: 800,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

    render(<ImageViewerPage />);

    await waitFor(() => expect(screen.getByTestId('page-processing')).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(1600);

    await waitFor(() => expect(screen.getByTestId('layer-editor')).toBeInTheDocument());
  });

  it('shows the missing screen when the status endpoint reports a 404', async () => {
    mocked.fetchImage.mockResolvedValue(makeImage({ status: 'PROCESSING' }));
    mocked.fetchImageStatus.mockRejectedValue(
      new ApiError(404, 'IMAGE_NOT_FOUND', 'Không tìm thấy'),
    );

    render(<ImageViewerPage />);

    await waitFor(() => expect(screen.getByTestId('page-processing')).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(1600);

    await waitFor(() => expect(screen.getByTestId('page-missing')).toBeInTheDocument());
  });
});
