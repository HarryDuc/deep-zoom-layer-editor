import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImageUpload, formatFileSize, validateImageFile } from './image-upload';
import * as apiClient from '@/services/api-client';
import { ApiError } from '@/lib/http';

vi.mock('@/services/api-client', () => ({
  uploadImage: vi.fn(),
}));

const mocked = vi.mocked(apiClient);

function makeFile(name: string, type: string, size = 1024): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('formatFileSize', () => {
  it('formats bytes, kilobytes and megabytes', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.00 MB');
  });
});

describe('validateImageFile', () => {
  it('accepts a JPEG', () => {
    expect(validateImageFile({ name: 'a.jpg', size: 100, type: 'image/jpeg' })).toBeNull();
  });

  it('accepts a PNG', () => {
    expect(validateImageFile({ name: 'a.png', size: 100, type: 'image/png' })).toBeNull();
  });

  it('rejects an unsupported type', () => {
    expect(validateImageFile({ name: 'a.gif', size: 100, type: 'image/gif' })).toMatch(
      /JPEG hoặc PNG/,
    );
  });

  it('rejects an unsupported extension even with an allowed MIME type', () => {
    expect(validateImageFile({ name: 'a.webp', size: 100, type: 'image/png' })).toMatch(
      /Phần mở rộng/,
    );
  });

  it('rejects an empty file', () => {
    expect(validateImageFile({ name: 'a.jpg', size: 0, type: 'image/jpeg' })).toMatch(/rỗng/);
  });

  it('rejects a file above the size limit', () => {
    expect(
      validateImageFile({ name: 'a.jpg', size: 600 * 1024 * 1024, type: 'image/jpeg' }),
    ).toMatch(/vượt quá 500 MB/);
  });

  it('accepts a 400 MB file, since the API limit is now 500 MB', () => {
    expect(
      validateImageFile({ name: 'a.jpg', size: 400 * 1024 * 1024, type: 'image/jpeg' }),
    ).toBeNull();
  });

  it('honours a custom size limit', () => {
    expect(validateImageFile({ name: 'a.jpg', size: 5 * 1024 * 1024, type: 'image/jpeg' }, 1)).toMatch(
      /vượt quá 1 MB/,
    );
  });
});

describe('ImageUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the file name and size after selection', async () => {
    const user = userEvent.setup();
    render(<ImageUpload onUploaded={vi.fn()} />);

    await user.upload(
      screen.getByTestId('upload-file-input'),
      makeFile('ban-do.jpg', 'image/jpeg', 2048),
    );

    expect(screen.getByTestId('upload-filename')).toHaveTextContent('ban-do.jpg');
    expect(screen.getByTestId('upload-filesize')).toHaveTextContent('2.0 KB');
  });

  it('pre-fills the display name without the extension', async () => {
    const user = userEvent.setup();
    render(<ImageUpload onUploaded={vi.fn()} />);

    await user.upload(
      screen.getByTestId('upload-file-input'),
      makeFile('ban-do-mat.jpg', 'image/jpeg'),
    );

    expect(screen.getByTestId('upload-name-input')).toHaveValue('ban-do-mat');
  });

  it('shows a validation error and does not select the file', async () => {
    // `applyAccept: false` lets the simulated picker hand over a rejected type,
    // which is what a user can do by choosing "All files" in the OS dialog.
    const user = userEvent.setup({ applyAccept: false });
    render(<ImageUpload onUploaded={vi.fn()} />);

    await user.upload(
      screen.getByTestId('upload-file-input'),
      makeFile('video.mp4', 'video/mp4'),
    );

    expect(screen.getByTestId('upload-validation-error')).toBeInTheDocument();
    expect(screen.queryByTestId('upload-filename')).toBeNull();
    expect(screen.getByTestId('upload-submit')).toBeDisabled();
  });

  it('uploads the file and reports the new image id', async () => {
    const user = userEvent.setup();
    const onUploaded = vi.fn();
    mocked.uploadImage.mockResolvedValue({
      _id: 'image-42',
      name: 'ban-do',
      originalFilename: 'ban-do.jpg',
      width: 100,
      height: 100,
      fileSize: 1024,
      mimeType: 'image/jpeg',
      status: 'PROCESSING',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    render(<ImageUpload onUploaded={onUploaded} />);

    await user.upload(
      screen.getByTestId('upload-file-input'),
      makeFile('ban-do.jpg', 'image/jpeg'),
    );
    await user.click(screen.getByTestId('upload-submit'));

    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith('image-42');
    });
    expect(screen.getByTestId('upload-success')).toBeInTheDocument();
  });

  it('shows the API error message when the upload fails', async () => {
    const user = userEvent.setup();
    mocked.uploadImage.mockRejectedValue(
      new ApiError(400, 'UNSUPPORTED_FILE_TYPE', 'Only JPEG and PNG images are supported'),
    );

    render(<ImageUpload onUploaded={vi.fn()} />);

    await user.upload(
      screen.getByTestId('upload-file-input'),
      makeFile('ban-do.jpg', 'image/jpeg'),
    );
    await user.click(screen.getByTestId('upload-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('upload-error')).toHaveTextContent(/JPEG and PNG/);
    });
  });

  it('clears the selection on reset', async () => {
    const user = userEvent.setup();
    render(<ImageUpload onUploaded={vi.fn()} />);

    await user.upload(
      screen.getByTestId('upload-file-input'),
      makeFile('ban-do.jpg', 'image/jpeg'),
    );
    await user.click(screen.getByTestId('upload-reset'));

    expect(screen.queryByTestId('upload-filename')).toBeNull();
    expect(screen.getByTestId('upload-submit')).toBeDisabled();
  });
});
