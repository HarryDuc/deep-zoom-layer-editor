'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ImageAsset, PaginationMeta } from '@deep-zoom/shared-types';
import { ImageUpload, formatFileSize } from '@/components/image-upload/image-upload';
import { ApiError } from '@/lib/http';
import { deleteImage, fetchImages } from '@/services/api-client';
import styles from './page.module.css';

const PAGE_SIZE = 12;

function StatusBadge({ status }: { status: ImageAsset['status'] }) {
  const className =
    status === 'COMPLETED'
      ? 'badge badge--completed'
      : status === 'FAILED'
        ? 'badge badge--failed'
        : 'badge badge--processing';
  const label =
    status === 'COMPLETED' ? 'Hoàn tất' : status === 'FAILED' ? 'Thất bại' : 'Đang xử lý';

  return (
    <span className={className} data-testid={`status-${status}`}>
      {status === 'PROCESSING' && <span className="spinner" aria-hidden="true" />}
      {label}
    </span>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadImages = useCallback(async (targetPage: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchImages(targetPage, PAGE_SIZE);
      setImages(result.data);
      setMeta(result.meta);
    } catch (loadError) {
      setError(
        loadError instanceof ApiError
          ? loadError.message
          : 'Không thể tải danh sách ảnh.',
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadImages(page);
  }, [loadImages, page]);

  const handleUploaded = useCallback(
    (imageId: string) => {
      router.push(`/images/${imageId}`);
    },
    [router],
  );

  const handleDelete = useCallback(
    async (imageId: string) => {
      if (deletingId) return;
      setDeletingId(imageId);
      setError(null);
      try {
        await deleteImage(imageId);
        await loadImages(page);
      } catch (deleteError) {
        setError(
          deleteError instanceof ApiError
            ? deleteError.message
            : 'Không thể xoá ảnh.',
        );
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, loadImages, page],
  );

  return (
    <main className="page">
      <h1 className="page-title">Deep Zoom Layer Editor</h1>
      <p className="page-subtitle">
        Tải ảnh độ phân giải lớn, xem dạng Deep Zoom và vẽ chồng lớp theo toạ độ pixel gốc.
      </p>

      <div className={styles.layout}>
        <ImageUpload onUploaded={handleUploaded} />
      </div>

      <section className={styles.listSection} aria-labelledby="image-list-heading">
        <div className={styles.listHeader}>
          <h2 id="image-list-heading" className={styles.listHeading}>
            Ảnh đã tải lên
          </h2>
          <button
            type="button"
            className="button button--small"
            onClick={() => void loadImages(page)}
            disabled={isLoading}
            data-testid="refresh-images"
          >
            Làm mới
          </button>
        </div>

        {error && (
          <p className="inline-error" role="alert" data-testid="list-error">
            {error}
          </p>
        )}

        {isLoading && images.length === 0 && (
          <p className="muted" data-testid="list-loading">
            Đang tải…
          </p>
        )}

        {!isLoading && images.length === 0 && !error && (
          <p className="muted" data-testid="list-empty">
            Chưa có ảnh nào. Hãy tải ảnh đầu tiên ở phía trên.
          </p>
        )}

        {images.length > 0 && (
          <div className={styles.tableWrap}>
            <table className="table">
              <thead>
                <tr>
                  <th>Tên</th>
                  <th>Kích thước</th>
                  <th>Dung lượng</th>
                  <th>Trạng thái</th>
                  <th>Ngày tạo</th>
                  <th aria-label="Hành động" />
                </tr>
              </thead>
              <tbody>
                {images.map((image) => (
                  <tr key={image._id} data-testid={`image-row-${image._id}`}>
                    <td>
                      <Link href={`/images/${image._id}`} data-testid={`open-${image._id}`}>
                        {image.name}
                      </Link>
                    </td>
                    <td className="muted">
                      {image.width && image.height ? `${image.width} × ${image.height}` : '—'}
                    </td>
                    <td className="muted">{formatFileSize(image.fileSize)}</td>
                    <td>
                      <StatusBadge status={image.status} />
                      {image.status === 'FAILED' && image.errorMessage && (
                        <div className={styles.errorDetail}>{image.errorMessage}</div>
                      )}
                    </td>
                    <td className="muted">
                      {new Date(image.createdAt).toLocaleString('vi-VN')}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <Link
                          href={`/images/${image._id}`}
                          className="button button--small"
                          data-testid={`edit-${image._id}`}
                        >
                          Mở
                        </Link>
                        <button
                          type="button"
                          className="button button--small button--danger"
                          onClick={() => void handleDelete(image._id)}
                          disabled={deletingId === image._id}
                          data-testid={`delete-${image._id}`}
                        >
                          {deletingId === image._id ? 'Đang xoá…' : 'Xoá'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {meta && meta.totalPages > 1 && (
          <div className={styles.pagination}>
            <button
              type="button"
              className="button button--small"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || isLoading}
            >
              Trước
            </button>
            <span className="muted" data-testid="pagination-info">
              Trang {meta.page} / {meta.totalPages}
            </span>
            <button
              type="button"
              className="button button--small"
              onClick={() => setPage((current) => Math.min(meta.totalPages, current + 1))}
              disabled={page >= meta.totalPages || isLoading}
            >
              Sau
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
