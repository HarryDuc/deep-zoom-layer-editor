'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImageAsset } from '@deep-zoom/shared-types';
import { LayerEditor } from '@/components/layer-editor/layer-editor';
import { ApiError } from '@/lib/http';
import { fetchImage, fetchImageStatus } from '@/services/api-client';
import styles from './page.module.css';

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 240; // ~6 minutes at 1.5s

type PageState = 'loading' | 'processing' | 'ready' | 'failed' | 'missing' | 'error';

export default function ImageViewerPage() {
  const params = useParams<{ imageId: string }>();
  const imageId = params.imageId;

  const [image, setImage] = useState<ImageAsset | null>(null);
  const [state, setState] = useState<PageState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const attemptsRef = useRef(0);

  /* ------------------------------ initial load ---------------------------- */

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setState('loading');
      setErrorMessage(null);

      try {
        const asset = await fetchImage(imageId);
        if (cancelled) return;

        setImage(asset);
        if (asset.status === 'COMPLETED') {
          setState('ready');
        } else if (asset.status === 'FAILED') {
          setState('failed');
          setErrorMessage(asset.errorMessage ?? 'Xử lý ảnh thất bại.');
        } else {
          setState('processing');
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setState('missing');
          return;
        }
        setState('error');
        setErrorMessage(
          error instanceof ApiError ? error.message : 'Không thể tải thông tin ảnh.',
        );
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [imageId]);

  /* --------------------------- processing polling ------------------------- */

  useEffect(() => {
    if (state !== 'processing') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      if (cancelled) return;

      attemptsRef.current += 1;
      if (attemptsRef.current > MAX_POLL_ATTEMPTS) {
        setState('failed');
        setErrorMessage(
          'Quá thời gian chờ xử lý. Tác vụ xử lý có thể đã bị gián đoạn — hãy tải lại trang.',
        );
        return;
      }

      try {
        const status = await fetchImageStatus(imageId);
        if (cancelled) return;

        if (status.status === 'COMPLETED') {
          // Re-fetch the asset so width/height are populated for the editor.
          const asset = await fetchImage(imageId);
          if (cancelled) return;
          setImage(asset);
          setState('ready');
          return;
        }

        if (status.status === 'FAILED') {
          setState('failed');
          setErrorMessage(status.errorMessage ?? 'Xử lý ảnh thất bại.');
          return;
        }

        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (error) {
        if (cancelled) return;
        // A transient network blip should not kill the poll loop; keep retrying
        // until the attempt budget runs out.
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        if (error instanceof ApiError && error.status === 404) {
          setState('missing');
        }
      }
    };

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [imageId, state]);

  const handleRetry = useCallback(() => {
    attemptsRef.current = 0;
    setState('loading');
    window.location.reload();
  }, []);

  /* -------------------------------- render -------------------------------- */

  if (state === 'loading') {
    return (
      <main className={styles.centered}>
        <span className="spinner" aria-hidden="true" />
        <p data-testid="page-loading">Đang tải thông tin ảnh…</p>
      </main>
    );
  }

  if (state === 'missing') {
    return (
      <main className={styles.centered}>
        <h1 className={styles.stateTitle}>Không tìm thấy ảnh</h1>
        <p className="muted" data-testid="page-missing">
          Ảnh có thể đã bị xoá hoặc đường dẫn không hợp lệ.
        </p>
        <Link href="/" className="button">
          Về danh sách ảnh
        </Link>
      </main>
    );
  }

  if (state === 'error') {
    return (
      <main className={styles.centered}>
        <h1 className={styles.stateTitle}>Đã xảy ra lỗi</h1>
        <p className="inline-error" role="alert" data-testid="page-error">
          {errorMessage}
        </p>
        <div className={styles.stateActions}>
          <button type="button" className="button" onClick={handleRetry}>
            Thử lại
          </button>
          <Link href="/" className="button">
            Về danh sách ảnh
          </Link>
        </div>
      </main>
    );
  }

  if (state === 'failed') {
    return (
      <main className={styles.centered}>
        <h1 className={styles.stateTitle}>Xử lý ảnh thất bại</h1>
        <p className="inline-error" role="alert" data-testid="page-processing-failed">
          {errorMessage}
        </p>
        <p className="muted">
          Nguyên nhân thường gặp: tệp không phải JPEG/PNG hợp lệ, vượt giới hạn pixel, hoặc tiến
          trình xử lý bị gián đoạn khi server khởi động lại.
        </p>
        <div className={styles.stateActions}>
          <button type="button" className="button" onClick={handleRetry}>
            Thử lại
          </button>
          <Link href="/" className="button">
            Về danh sách ảnh
          </Link>
        </div>
      </main>
    );
  }

  if (state === 'processing' || !image) {
    return (
      <main className={styles.centered}>
        <span className="spinner" aria-hidden="true" />
        <h1 className={styles.stateTitle}>Đang tạo lớp ảnh Deep Zoom</h1>
        <p className="muted" data-testid="page-processing">
          Ảnh đã được tải lên an toàn. Quá trình tạo tile pyramid đang chạy ở chế độ nền — trang
          này sẽ tự chuyển khi hoàn tất.
        </p>
        <Link href="/" className="button">
          Về danh sách ảnh
        </Link>
      </main>
    );
  }

  return (
    <main className={styles.editorPage} data-testid="image-viewer-page">
      <LayerEditor image={image} />
    </main>
  );
}
