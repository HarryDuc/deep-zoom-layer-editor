import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImageAsset } from '@deep-zoom/shared-types';
import HomePage from './page';
import * as apiClient from '@/services/api-client';
import { ApiError } from '@/lib/http';

/**
 * Tests for the image list page.
 *
 * The page is the entry point of the app: it lists the uploaded assets, lets
 * the user delete one and navigates to the editor after an upload. The API
 * client is stubbed so the states (loading, empty, error, populated) can be
 * driven deterministically.
 */

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/services/api-client', () => ({
  fetchImages: vi.fn(),
  deleteImage: vi.fn(),
}));

vi.mock('@/components/image-upload/image-upload', () => ({
  ImageUpload: ({ onUploaded }: { onUploaded: (imageId: string) => void }) => (
    <button type="button" data-testid="mock-upload" onClick={() => onUploaded('image-new')}>
      upload
    </button>
  ),
  formatFileSize: (bytes: number): string => `${bytes} B`,
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

const META = { page: 1, limit: 12, total: 1, totalPages: 1 };

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.fetchImages.mockResolvedValue({ data: [makeImage()], meta: META });
    mocked.deleteImage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the images returned by the API', async () => {
    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('image-row-image-1')).toBeInTheDocument());
    expect(mocked.fetchImages).toHaveBeenCalledWith(1, 12);
    expect(screen.getByText('Bản đồ vệ tinh')).toBeInTheDocument();
  });

  it('shows the size of an image that has been processed', async () => {
    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('image-row-image-1')).toBeInTheDocument());
    expect(screen.getByText('1000 × 800')).toBeInTheDocument();
  });

  it('shows a dash when the dimensions are not known yet', async () => {
    mocked.fetchImages.mockResolvedValue({
      data: [makeImage({ width: undefined, height: undefined })],
      meta: META,
    });

    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('image-row-image-1')).toBeInTheDocument());
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the empty state when there is no image', async () => {
    mocked.fetchImages.mockResolvedValue({ data: [], meta: { ...META, total: 0, totalPages: 0 } });

    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('list-empty')).toBeInTheDocument());
  });

  it('shows the loading state before the first response arrives', () => {
    mocked.fetchImages.mockReturnValue(new Promise(() => undefined));

    render(<HomePage />);

    expect(screen.getByTestId('list-loading')).toBeInTheDocument();
  });

  it('shows an API error message', async () => {
    mocked.fetchImages.mockRejectedValue(
      new ApiError(500, 'SERVER_ERROR', 'Máy chủ đang bận'),
    );

    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('list-error')).toHaveTextContent('Máy chủ đang bận'));
  });

  it('shows a generic message for a non-API error', async () => {
    mocked.fetchImages.mockRejectedValue(new Error('network down'));

    render(<HomePage />);

    await waitFor(() =>
      expect(screen.getByTestId('list-error')).toHaveTextContent('Không thể tải danh sách ảnh.'),
    );
  });

  it('navigates to the editor after an upload', async () => {
    const user = userEvent.setup();
    render(<HomePage />);

    await user.click(screen.getByTestId('mock-upload'));

    expect(mockPush).toHaveBeenCalledWith('/images/image-new');
  });

  it('deletes an image and reloads the list', async () => {
    const user = userEvent.setup();
    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('delete-image-1')).toBeInTheDocument());
    mocked.fetchImages.mockClear();

    await user.click(screen.getByTestId('delete-image-1'));

    await waitFor(() => expect(mocked.deleteImage).toHaveBeenCalledWith('image-1'));
    await waitFor(() => expect(mocked.fetchImages).toHaveBeenCalled());
  });

  it('shows an error when the delete fails', async () => {
    const user = userEvent.setup();
    mocked.deleteImage.mockRejectedValue(
      new ApiError(409, 'IMAGE_BUSY', 'Ảnh đang được xử lý'),
    );

    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('delete-image-1')).toBeInTheDocument());
    await user.click(screen.getByTestId('delete-image-1'));

    await waitFor(() =>
      expect(screen.getByTestId('list-error')).toHaveTextContent('Ảnh đang được xử lý'),
    );
  });

  it('shows a generic message when the delete fails unexpectedly', async () => {
    const user = userEvent.setup();
    mocked.deleteImage.mockRejectedValue(new Error('boom'));

    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('delete-image-1')).toBeInTheDocument());
    await user.click(screen.getByTestId('delete-image-1'));

    await waitFor(() =>
      expect(screen.getByTestId('list-error')).toHaveTextContent('Không thể xoá ảnh.'),
    );
  });

  it('renders a badge for every processing state', async () => {
    mocked.fetchImages.mockResolvedValue({
      data: [
        makeImage({ _id: 'done', status: 'COMPLETED' }),
        makeImage({ _id: 'busy', status: 'PROCESSING' }),
        makeImage({ _id: 'broken', status: 'FAILED', errorMessage: 'Tệp hỏng' }),
      ],
      meta: { ...META, total: 3 },
    });

    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('status-COMPLETED')).toBeInTheDocument());
    expect(screen.getByTestId('status-PROCESSING')).toBeInTheDocument();
    expect(screen.getByTestId('status-FAILED')).toBeInTheDocument();
    expect(screen.getByText('Tệp hỏng')).toBeInTheDocument();
  });

  it('shows the pagination controls only when there is more than one page', async () => {
    mocked.fetchImages.mockResolvedValue({
      data: [makeImage()],
      meta: { page: 1, limit: 12, total: 30, totalPages: 3 },
    });

    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('pagination-info')).toHaveTextContent('Trang 1 / 3'));
  });

  it('hides the pagination controls for a single page', async () => {
    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('image-row-image-1')).toBeInTheDocument());
    expect(screen.queryByTestId('pagination-info')).not.toBeInTheDocument();
  });

  it('requests the next page when the user navigates forward', async () => {
    const user = userEvent.setup();
    mocked.fetchImages.mockResolvedValue({
      data: [makeImage()],
      meta: { page: 1, limit: 12, total: 30, totalPages: 3 },
    });

    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('pagination-info')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Sau' }));

    await waitFor(() => expect(mocked.fetchImages).toHaveBeenCalledWith(2, 12));
  });

  it('reloads the list when the refresh button is used', async () => {
    const user = userEvent.setup();
    render(<HomePage />);

    await waitFor(() => expect(screen.getByTestId('image-row-image-1')).toBeInTheDocument());
    mocked.fetchImages.mockClear();

    await user.click(screen.getByTestId('refresh-images'));

    await waitFor(() => expect(mocked.fetchImages).toHaveBeenCalledWith(1, 12));
  });
});
