'use client';

import { useCallback, useRef, useState } from 'react';
import { ApiError } from '@/lib/http';
import { uploadImage } from '@/services/api-client';
import styles from './image-upload.module.css';

const MAX_FILE_SIZE_MB = 500;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

export interface ImageUploadProps {
  /** Called with the new asset id once the API has accepted the upload. */
  onUploaded: (imageId: string) => void;
  maxSizeMb?: number;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Client-side pre-validation mirrors the API rules so users get instant
 * feedback. The API remains the authority: it re-checks MIME type, extension
 * and real decoded format.
 */
export function validateImageFile(
  file: { name: string; size: number; type: string },
  maxSizeMb = MAX_FILE_SIZE_MB,
): string | null {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();

  if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTENSIONS.includes(extension)) {
    return 'Chỉ hỗ trợ ảnh JPEG hoặc PNG.';
  }
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return 'Phần mở rộng tệp phải là .jpg, .jpeg hoặc .png.';
  }
  if (file.size === 0) {
    return 'Tệp rỗng. Vui lòng chọn ảnh khác.';
  }
  if (file.size > maxSizeMb * 1024 * 1024) {
    return `Dung lượng tệp vượt quá ${maxSizeMb} MB.`;
  }
  return null;
}

type UploadPhase = 'idle' | 'uploading' | 'done' | 'error';

export function ImageUpload({ onUploaded, maxSizeMb = MAX_FILE_SIZE_MB }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const reset = useCallback(() => {
    setSelectedFile(null);
    setDisplayName('');
    setValidationError(null);
    setPhase('idle');
    setErrorMessage(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  const acceptFile = useCallback(
    (file: File) => {
      const error = validateImageFile(file, maxSizeMb);
      setValidationError(error);
      setErrorMessage(null);
      setPhase('idle');

      if (error) {
        setSelectedFile(null);
        return;
      }

      setSelectedFile(file);
      // Default the display name to the filename without its extension.
      const dotIndex = file.name.lastIndexOf('.');
      setDisplayName(dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name);
    },
    [maxSizeMb],
  );

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file) {
      acceptFile(file);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      acceptFile(file);
    }
  };

  const handleUpload = async (): Promise<void> => {
    if (!selectedFile || phase === 'uploading') return;

    setPhase('uploading');
    setErrorMessage(null);

    try {
      const asset = await uploadImage(selectedFile, displayName);
      setPhase('done');
      onUploaded(asset._id);
    } catch (error) {
      setPhase('error');
      setErrorMessage(
        error instanceof ApiError
          ? error.message
          : 'Tải ảnh thất bại. Vui lòng thử lại.',
      );
    }
  };

  const isBusy = phase === 'uploading';

  return (
    <section className={styles.wrapper} aria-labelledby="upload-heading">
      <h2 id="upload-heading" className={styles.heading}>
        Tải ảnh lên
      </h2>
      <p className={styles.hint}>
        Hỗ trợ JPEG và PNG, tối đa {maxSizeMb} MB. Ảnh sẽ được xử lý thành lớp ảnh Deep Zoom ở chế
        độ nền.
      </p>

      <div
        className={`${styles.dropzone} ${isDragging ? styles.dropzoneActive : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Chọn hoặc kéo thả ảnh"
        data-testid="upload-dropzone"
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,.jpg,.jpeg,.png"
          onChange={handleFileChange}
          className={styles.fileInput}
          data-testid="upload-file-input"
        />
        {selectedFile ? (
          <div className={styles.fileInfo}>
            <strong data-testid="upload-filename">{selectedFile.name}</strong>
            <span className="muted" data-testid="upload-filesize">
              {formatFileSize(selectedFile.size)}
            </span>
          </div>
        ) : (
          <div className={styles.placeholder}>
            <span className={styles.placeholderIcon} aria-hidden="true">
              ⬚
            </span>
            <span>Nhấn để chọn ảnh hoặc kéo thả vào đây</span>
          </div>
        )}
      </div>

      {validationError && (
        <p className="inline-error" role="alert" data-testid="upload-validation-error">
          {validationError}
        </p>
      )}

      {selectedFile && (
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="upload-name">Tên ảnh</label>
          <input
            id="upload-name"
            type="text"
            value={displayName}
            maxLength={200}
            onChange={(event) => setDisplayName(event.target.value)}
            disabled={isBusy}
            data-testid="upload-name-input"
          />
        </div>
      )}

      {errorMessage && (
        <p className="inline-error" role="alert" data-testid="upload-error">
          {errorMessage}
        </p>
      )}

      {phase === 'done' && (
        <p className="inline-success" data-testid="upload-success">
          Tải lên thành công. Đang chuyển tới trình xem…
        </p>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className="button button--primary"
          onClick={handleUpload}
          disabled={!selectedFile || isBusy}
          data-testid="upload-submit"
        >
          {isBusy ? (
            <>
              <span className="spinner" aria-hidden="true" /> Đang tải lên…
            </>
          ) : (
            'Tải lên'
          )}
        </button>
        <button
          type="button"
          className="button"
          onClick={reset}
          disabled={(!selectedFile && !errorMessage) || isBusy}
          data-testid="upload-reset"
        >
          Xoá chọn
        </button>
      </div>
    </section>
  );
}
