# Deep Zoom Image (DZI) & Layer Editor

A standalone MVP for viewing very large images with Deep Zoom and annotating them with
interactive vector layers.

- **Frontend** — Next.js 15 (App Router), React 19, TypeScript, OpenSeadragon, SVG overlay.
- **Backend** — NestJS 11, TypeScript, REST API, Mongoose/MongoDB, Sharp/libvips, local storage.
- **Shared** — `@deep-zoom/shared-types` holds every DTO and geometry type used by both sides.

The project is completely independent of any other system: it talks to MongoDB directly, stores
files on the local filesystem and needs no Docker, Redis or message queue.

---

## 1. Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | 20 LTS or 22 LTS | `node --version` |
| npm | 10+ (ships with Node 20) | npm workspaces are required |
| MongoDB | 6.0+ | Local install or a free Atlas cluster |
| Sharp | 0.34.5 | Installed automatically; ships prebuilt libvips binaries |

MongoDB is the only external service. Everything else runs in-process.

### Installing MongoDB locally

**Windows**

```powershell
winget install MongoDB.Server
# or download the MSI from https://www.mongodb.com/try/download/community
```

**macOS (Homebrew)**

```bash
brew install mongodb-community
brew services start mongodb-community
```

**Linux (Docker is fine here — it is only a local dev database)**

```bash
docker run -d --name mongo -p 27017:27017 mongo:7
```

Verify the daemon is reachable:

```bash
mongosh --eval "db.runCommand({ ping: 1 })"
```

**MongoDB Atlas** works too — copy the connection string into `MONGODB_URI` and add
`?retryWrites=true&w=majority` if your cluster requires it.

---

## 2. Install dependencies

The repo uses npm workspaces, so a single install at the root covers all three packages:

```bash
npm install
```

`npm install` also builds the `sharp` native binary. If it is skipped on your platform, run:

```bash
npm rebuild sharp
```

---

## 3. Configure the environment

### Backend — `.env` in the repository root

Copy the template and adjust the values:

```bash
cp .env.example .env
```

```dotenv
NODE_ENV=development
PORT=3001

MONGODB_URI=mongodb://127.0.0.1:27017/deep_zoom_layer_editor

# Relative paths are resolved against the monorepo root, so `data` works
# no matter which directory the API is started from.
APP_STORAGE_DIR=data

MAX_UPLOAD_SIZE_MB=500
MAX_IMAGE_PIXELS=100000000

DZI_TILE_SIZE=256
DZI_TILE_OVERLAP=1
DZI_TILE_FORMAT=jpeg
DZI_TILE_QUALITY=82

IMAGE_PROCESSING_CONCURRENCY=1
IMAGE_PROCESSING_TIMEOUT_MS=300000

FRONTEND_ORIGIN=http://localhost:3000
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | API port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/deep_zoom_layer_editor` | MongoDB connection string |
| `APP_STORAGE_DIR` | `data` | Root of `originals/`, `dzi/`, `tiles/`, `overlays/`, `tmp/` |
| `MAX_UPLOAD_SIZE_MB` | `100` (template ships `500`) | Upload size limit |
| `MAX_IMAGE_PIXELS` | `100000000` | Pixel budget per image (≈ 10 000 × 10 000). This is the **only** pixel ceiling: libvips' own 268 MP limit is disabled in code |
| `DZI_TILE_SIZE` | `256` | Tile edge length in pixels (64–2048) |
| `DZI_TILE_OVERLAP` | `1` | Tile overlap in pixels (0–10) |
| `DZI_TILE_FORMAT` | `jpeg` | `jpeg` or `png` |
| `DZI_TILE_QUALITY` | `82` | JPEG quality (1–100) |
| `IMAGE_PROCESSING_CONCURRENCY` | `1` | How many images are tiled at the same time |
| `IMAGE_PROCESSING_TIMEOUT_MS` | `300000` | Per-image processing timeout (5 min) |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Allowed CORS origin |

Invalid values (a non-numeric port, a negative overlap, a non-positive size) make the API fail
fast at boot with an explicit message instead of misbehaving later.

### Frontend — `.env.local` in `apps/web`

```bash
cp .env.example.web apps/web/.env.local
```

```dotenv
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1
```

This is the only browser-visible setting. The web app never talks to MongoDB and holds no
secrets, so nothing sensitive belongs in this file.

> **Note** — `NEXT_PUBLIC_*` values are inlined at build time. Restart `npm run dev` after
> changing them, and rebuild (`npm run build`) before running the production server.

---

## 4. Run both applications

```bash
npm run dev
```

This starts the API on <http://localhost:3001> and the web app on <http://localhost:3000> in one
terminal, with prefixed logs (`api` / `web`).

To run them separately:

```bash
npm run dev:api    # NestJS, watch mode
npm run dev:web    # Next.js dev server
```

- Web app: <http://localhost:3000>
- API: <http://localhost:3001/api/v1>
- Swagger UI: <http://localhost:3001/api/docs>
- Health check: <http://localhost:3001/api/v1/health>

---

## 5. Walkthrough — from upload to saved annotation

### 5.1 Upload an image

Open <http://localhost:3000> and use the upload panel. JPEG and PNG are accepted, up to
`MAX_UPLOAD_SIZE_MB` (500 MB in the shipped template). The file name becomes the display name
unless you provide one.

The API stores the original, creates the metadata row with status `PROCESSING` and returns
immediately — the DZI pyramid is built in the background so a 500 MB upload does not block on
tiling.

### 5.2 Watch the DZI processing

After the upload the app opens `/images/<imageId>`. The page polls the status endpoint every
1.5 s and shows one of:

| Status | Screen |
| --- | --- |
| `PROCESSING` | "Đang tạo lớp ảnh Deep Zoom" with a spinner |
| `COMPLETED` | The OpenSeadragon viewer |
| `FAILED` | The stored failure reason plus a retry button |

The status is also queryable directly:

```bash
curl http://localhost:3001/api/v1/images/<imageId>/status
```

### 5.3 Open the viewer

Once ready, the viewer loads the DZI descriptor and streams tiles on demand. Pan with
drag, zoom with the wheel or the toolbar buttons. The overlay stays locked to the image
during zoom, pan and resize.

### 5.4 Choose a mode, then create layers and objects

The toolbar has an explicit mode switch:

| Mode | Behaviour |
| --- | --- |
| **Xem** (view) | Layers are pure visual content. Objects are not clickable and never swallow a gesture, so dragging and scrolling pan/zoom the image even directly on top of a shape. |
| **Chỉnh sửa** (edit) | Objects become selectable and the drawing tools work on the active layer. Arming any tool switches to edit mode automatically. |

Selecting a layer in the left panel also raises it visually above the other layers, so the
layer you are working on is never hidden behind another one. This is a presentation-only
reordering: no `zIndex` is written to the database.

- **Layers** (left panel) — add, rename, toggle visibility, lock, reorder, delete. A locked
  layer disables the drawing tools.
- **Objects** — pick a tool in the toolbar, then draw on the canvas:

  | Tool | Gesture |
  | --- | --- |
  | Đa giác (polygon) | Click to add points, `Enter` or double-click to close, `Escape` to cancel |
  | Chữ nhật (rectangle) | Drag a box |
  | Điểm (point) | Click a position |
  | Nhãn (label) | Click a position, then edit the text in the properties panel |
  | Ảnh (image overlay) | Drag a box, then upload a PNG/WebP/JPEG overlay in the properties panel |

All geometry is stored in **original-image pixel coordinates**, not screen pixels, so an
annotation stays exactly where it was drawn at any zoom level.

When an image overlay is uploaded, the drawn box is automatically reshaped to the bitmap's
aspect ratio and the SVG renders it with `preserveAspectRatio="xMidYMid meet"`, so a detailed
overlay is scaled uniformly instead of being squashed.

### 5.5 Save, reload and verify persistence

Edits are local until you press **Lưu thay đổi**. Then:

1. Press **Lưu thay đổi** and wait for the "Đã lưu" confirmation.
2. Reload the browser page (or press **Tải lại**).
3. The layers, objects, geometry and styles are restored from MongoDB, still aligned with
   the image.

---

## 6. API reference

All routes are prefixed with `/api/v1`. Responses are wrapped in a `{ data, meta? }` envelope,
and errors use `{ statusCode, code, message }`.

### Health

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness plus database connectivity |

### Images

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/images` | Upload (multipart `file`, optional `name`) |
| `GET` | `/images?page=&limit=` | Paginated list, newest first |
| `GET` | `/images/:imageId` | Asset metadata |
| `GET` | `/images/:imageId/status` | Processing status |
| `GET` | `/images/:imageId/dzi` | DZI descriptor (XML) |
| `GET` | `/images/:imageId/tiles/:level/:tile` | A single tile (e.g. `12/3_4.jpg`) |
| `POST` | `/images/:imageId/overlays` | Upload an overlay asset (PNG/WebP/JPEG); a DZI pyramid is generated for it |
| `GET` | `/images/:imageId/overlays/:overlayId` | Serve an overlay asset |
| `GET` | `/images/:imageId/overlays/:overlayId/dzi` | Overlay DZI descriptor (XML) |
| `GET` | `/images/:imageId/overlays/:overlayId/tiles/:level/:tile` | A single overlay tile |
| `DELETE` | `/images/:imageId` | Delete the asset, its layers, objects, overlays and files |

### Layers

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/images/:imageId/layers` | List layers in stacking order |
| `POST` | `/images/:imageId/layers` | Create a layer |
| `PATCH` | `/layers/:layerId` | Update name / visibility / lock / zIndex |
| `DELETE` | `/layers/:layerId` | Delete a layer and its objects |

### Layer objects

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/layers/:layerId/objects` | List objects |
| `POST` | `/layers/:layerId/objects` | Create an object |
| `PATCH` | `/layer-objects/:objectId` | Update geometry / style / metadata / visibility |
| `DELETE` | `/layer-objects/:objectId` | Delete an object |
| `PATCH` | `/layers/:layerId/objects/order` | Reorder with `{ "orderedObjectIds": [...] }` |

---

## 7. Tests, lint, typecheck and build

```bash
npm run lint          # ESLint (API + web), zero warnings allowed
npm run typecheck     # tsc --noEmit for both apps
npm run test          # API unit/integration tests, then web unit tests
npm run test:e2e      # Playwright end-to-end suite
npm run test:all      # unit + integration + e2e
npm run build         # shared-types, then API, then web production build
```

Individually:

```bash
npm run test --workspace=@deep-zoom/api              # 372 tests (Jest)
npm run test:integration --workspace=@deep-zoom/api   # integration only
npm run test --workspace=@deep-zoom/web              # 287 tests (Vitest)
npm run test:e2e:ui                                  # Playwright with the UI inspector
```

Current coverage: **94 %** statements / **78 %** branches on the API and **95 %** statements on
the web app.

### What the suites cover

- **API unit tests** — upload validation (MIME, extension, decoded format, MIME mismatch,
  pixel budget), rollback on failure, DZI descriptor generation and tile-path traversal
  defence, storage key/path containment, the task manager's concurrency limit, layer and
  object ownership rules, style and metadata normalization, background-job recovery.
- **API integration tests** — a real in-memory MongoDB plus real Sharp pipelines against the
  full HTTP surface.
- **Web unit tests** — coordinate transforms, editor state machine (including display
  ordering and active-layer elevation), the OpenSeadragon lifecycle hook, the SVG overlay
  renderer, the DziViewer interaction layer and view/edit modes, the layer editor, the
  properties panel and both app pages.
- **E2E tests** — upload → DZI processing → draw → save → reload against the real API,
  MongoDB and Sharp output.

### End-to-end tests

The Playwright suite starts its own API (port 3101) and web app (port 3100) so it never
disturbs a running `npm run dev`. It uses a separate database (`deep_zoom_layer_editor_e2e`)
and a separate storage root (`data-e2e/`), and builds Next.js into `.next-e2e/` so the
developer bundle is never overwritten with test-port API URLs.

```bash
npx playwright install chromium   # first time only
npm run test:e2e
```

---

## 8. Background processing: limitations and recovery

### How it works

Uploading returns as soon as the original is safely on disk and the metadata row exists. The
DZI pyramid is then built by an in-process task queue:

1. `TaskManagerService` runs at most `IMAGE_PROCESSING_CONCURRENCY` jobs at a time and
   deduplicates by asset id.
2. The job builds the pyramid under `tmp/job-<key>/` with libvips' native Deep Zoom writer
   (`dzsave`), which uses the source codec's shrink-on-load to produce every level below full
   resolution without decoding the whole image. A 2922 MP scan becomes a 17-level pyramid in
   about three minutes.
3. The finished descriptor and tile tree are moved into `dzi/` in a single step per entry, so
   a partially written pyramid is never visible to a client.
4. The asset row is updated to `COMPLETED` with the final dimensions. On any error it is
   updated to `FAILED` with a short, client-safe reason, and the partial pyramid is removed.

The job directory is always cleaned up, and stale `tmp/` uploads are purged on boot.

> **Tile file names.** libvips names its tiles `<x>_<y>.jpeg` (or `.png` for overlays), and the
> descriptor's `Format` attribute says exactly that. OpenSeadragon builds every tile URL from
> `Format` verbatim, so the two must never disagree — a mismatch makes *every* tile request
> 404 while the viewer silently stays blank.

### The limitation

**These tasks live in the API process's memory. They do not survive a restart.** If the API is
stopped, crashes or is redeployed while a pyramid is being built, that job is lost — the
original file survives, but the pyramid does not.

### How a stuck state is handled

On boot, `ImageProcessingService.onModuleInit()` marks every asset still in `PROCESSING` as
`FAILED` with the message:

> Processing was interrupted because the server restarted. Please upload the image again.

This is deliberate. A `PROCESSING` asset would otherwise make the UI poll forever, since no
worker exists any more to ever complete it. The user sees an explicit, actionable error and
can re-upload.

To process an image again, delete it and upload it once more. There is no resume: the
intermediate level images are not persisted, so a restart always means starting over.

---

## 9. Troubleshooting

### "Cannot reach the API. Is the backend running?"

The web app could not reach `NEXT_PUBLIC_API_BASE_URL`.

1. Check the API is up: `curl http://localhost:3001/api/v1/health` should return
   `{"status":"ok","database":"connected",...}`.
2. Check `NEXT_PUBLIC_API_BASE_URL` in `apps/web/.env.local` matches the API's actual port
   and includes the `/api/v1` suffix.
3. Restart `npm run dev` — `NEXT_PUBLIC_*` values are inlined at build time, so a running
   dev server keeps the old value until it restarts.
4. Check the API's CORS origin: `FRONTEND_ORIGIN` must match the web app's URL exactly,
   including the scheme and port.

### The API exits with a MongoDB connection error

```
MongoServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017
```

MongoDB is not running or `MONGODB_URI` points somewhere else.

1. Start MongoDB and verify with `mongosh --eval "db.runCommand({ ping: 1 })"`.
2. Check `MONGODB_URI` — the default is
   `mongodb://127.0.0.1:27017/deep_zoom_layer_editor`.
3. For Atlas, make sure the cluster allows your IP and the URL is complete.
4. The API starts even when the database is down, so the app still loads; the health
   endpoint then reports `degraded` / `disconnected`.

### DZI processing fails

Open the image and read the error message shown in the "Xử lý ảnh thất bại" screen, or query
`/images/:imageId/status`.

| Message | Cause | Fix |
| --- | --- | --- |
| `The uploaded file is empty` | Zero-byte upload | Upload a real file |
| `File exceeds the N MB limit` | Over `MAX_UPLOAD_SIZE_MB` | Raise the limit or use a smaller file |
| `File content is not a JPEG or PNG image` | Extension says `.jpg` but the bytes are something else | Re-export the image as JPEG or PNG |
| `File content does not match the declared content type` | A PNG announced as JPEG | Re-export with the correct extension |
| `Image has N pixels, exceeding the limit of M` | Over `MAX_IMAGE_PIXELS` | Raise the limit or downscale the source |
| `Input image exceeds pixel limit` | libvips' own 268 MP cap (a plain `sharp()` call without `limitInputPixels: false`) | Fixed — all decoding goes through `openImage()`; see "Sharp pixel limits" below |
| `Image processing timed out` | The job exceeded `IMAGE_PROCESSING_TIMEOUT_MS` | Raise the timeout, or use a smaller image |
| `Image processing was aborted` | The job was cancelled before the timeout | Check the API log for the elapsed time and the reason |
| `Processing was interrupted because the server restarted` | The API restarted mid-job | Delete the image and upload it again |
| `Original image file is missing from storage` | `data/` was wiped but MongoDB kept the row | Delete the asset and upload it again |

### The viewer is blank or tiles return 404

- The DZI descriptor's `Url` attribute must be absolute and point at the API. The API
  absolutizes it against the request origin, so a request through a reverse proxy must forward
  `X-Forwarded-Proto` and `X-Forwarded-Host`.
- Confirm the tile route works:
  `curl -I http://localhost:3001/api/v1/images/<imageId>/tiles/12/0_0.jpg`
  (the level and tile name depend on the image size).
- Check the asset actually finished: a `PROCESSING` or `FAILED` asset returns `409`.

### Pan and zoom do not work in the viewer

The SVG overlay must keep `pointer-events: none` on its root element. Only the individual
object shapes opt back in through the `.object` class, and only in edit mode. If the root SVG
ever becomes interactive, it covers the whole viewer and swallows the drag-to-pan and
wheel-to-zoom gestures. There is a regression test for exactly this in
`apps/web/src/components/dzi-viewer/dzi-viewer.test.tsx`, and the end-to-end suite drives a
real mouse drag and wheel over a drawn object in
`tests/e2e/editor-flow.spec.ts` ("zoom and pan keep the viewer instance and overlays anchored").

### "Input image exceeds pixel limit" even though `MAX_IMAGE_PIXELS` was raised

This message comes from **libvips**, not from the application. libvips refuses to decode any
image with more than 268 402 689 pixels (roughly 16 383 × 16 383) unless the caller opts out
with `limitInputPixels: false`. That ceiling is independent of `MAX_IMAGE_PIXELS`, so raising
the config value used to let the upload through and then fail later, during DZI generation,
with a message that had nothing to do with the configured limit.

Every decode in the API now goes through `apps/api/src/common/sharp/sharp-input.ts`, which
passes `limitInputPixels: false`. A unit test walks `apps/api/src` and fails if any production
file calls `sharp()` directly, so the ceiling cannot come back unnoticed.

`MAX_IMAGE_PIXELS` is therefore the single, authoritative pixel budget.

### Large scans abort with "Image processing was aborted"

This was the second half of the same problem. The pyramid used to be built by hand: every
level was decoded from the original at full resolution, materialised as a tiled TIFF, and
every tile was then extracted from that TIFF. On a large scan that meant decoding the whole
image once *per level* — 16 full decodes of a 121 MB file — which took over half an hour and
always hit `IMAGE_PROCESSING_TIMEOUT_MS`.

The generator now uses libvips' native Deep Zoom writer (`dzsave`), which uses the source
codec's shrink-on-load to build every lower level without ever decoding the full image. The
same 2922 MP scan now takes **about three minutes** instead of timing out.

Progress is logged at every step, so the API console shows where a long run stands:

```
LOG [ImageProcessingService] Processing asset 6ae06151... ("background_9-8x", 121.5 MB) — timeout 3000s
LOG [DziGeneratorService] Starting pyramid for 18b7bc0b...: 65209x44806 (2921.8 MP), 17 levels, 59913 tiles, 256px jpeg, overlap 1
LOG [DziGeneratorService] Generated DZI 18b7bc0b...: 65209x44806, 17 levels, 59913 tiles in 116.6s
LOG [ImageProcessingService] Promoting the pyramid of 6ae06151... into the DZI bucket (59913 tiles)
LOG [ImageProcessingService] Asset 6ae06151... processed (59913 tiles) in 192.1s
```

A timeout is now reported explicitly instead of the bare "aborted":

```
ERROR [ImageProcessingService] Asset 6ae06151... failed after 300.0s: Image processing timed out
  after 300s. The image is too large to process with the current limits.
  — the processing timeout of 300s was reached. Raise IMAGE_PROCESSING_TIMEOUT_MS or lower MAX_IMAGE_PIXELS.
```

### `npm run dev` fails on Windows with `EBUSY` or "resource busy or locked"

libvips keeps file handles open in its file cache, which makes those files undeletable on
Windows. The API disables the libvips file cache globally
(`apps/api/src/common/sharp/sharp-cache.ts`) so temporary files can always be removed.

### The E2E suite fails with "port already in use"

Another process is using 3100/3101, or a previous run is still alive. Stop it, or point the
suite elsewhere:

```bash
E2E_WEB_PORT=3200 E2E_API_PORT=3201 npm run test:e2e
```

To run against already-running servers, set `E2E_NO_WEB_SERVER=1` and point
`E2E_BASE_URL` / `E2E_API_URL` at them.

---

## 10. Project layout

```
deep-zoom-layer-editor/
├── apps/
│   ├── api/                       # NestJS backend
│   │   ├── src/
│   │   │   ├── common/            # errors, filters, interceptors, validators, multer
│   │   │   ├── config/            # env parsing and validation
│   │   │   ├── database/          # Mongoose model registration
│   │   │   ├── health/            # liveness + DB connectivity
│   │   │   ├── image-processing/  # DZI generator, task manager, background pipeline
│   │   │   ├── images/            # assets, uploads, DZI serving, overlays
│   │   │   ├── layer-objects/     # annotation objects
│   │   │   ├── layers/            # layer CRUD and ownership
│   │   │   └── storage/           # all filesystem access
│   │   └── test/                  # integration suite
│   └── web/                       # Next.js frontend
│       └── src/
│           ├── app/               # routes: / and /images/[imageId]
│           ├── components/        # dzi-viewer, layer-editor, image-upload
│           ├── hooks/             # use-open-seadragon, use-layer-editor
│           ├── lib/               # http, api-config, coordinate-transform, editor-state
│           └── services/          # typed API client
├── packages/shared-types/         # DTOs and geometry types
├── tests/e2e/                     # Playwright specs
└── data/                          # runtime storage (git-ignored)
    ├── originals/  dzi/  tiles/  overlays/  tmp/
```

### Storage layout on disk

```
data/
├── originals/<storageKey>.jpg          # the uploaded file
├── dzi/<storageKey>.dzi                # the DZI descriptor (XML)
├── dzi/<storageKey>_files/<level>/<x>_<y>.jpg
├── overlays/<storageKey>/<overlayKey>.{png,webp,jpg}   # overlay bitmap
├── overlays/<storageKey>/<overlayKey>.dzi              # overlay descriptor
├── overlays/<storageKey>/<overlayKey>_files/<level>/<x>_<y>.png
└── tmp/                                # uploads in flight and job scratch space
```

Tiles live next to the descriptor in `<storageKey>_files/`, which is the layout the DZI
convention expects. The `tiles/` bucket is reserved for future use and stays empty.

Storage keys are opaque random hex strings, never derived from user input. Every path is
resolved and containment-checked against its bucket, so a crafted id or tile path cannot
escape the storage root.

---

## 11. Design notes

**Geometry is stored in original-image pixels.** The viewer converts between image space and
screen space through OpenSeadragon's own `imageToViewerElementCoordinates()` /
`viewerElementToImageCoordinates()`, so no scale factor is duplicated in application code.
This is what makes an annotation survive zoom, pan and browser resize.

**The viewer is created once.** Changing the selection, the layers or the objects re-renders
the SVG overlay but never re-initializes OpenSeadragon, so the image does not flash or reset
while the user is editing.

**Pan and zoom never re-render React.** The SVG overlay keeps the base image's pixel grid
(`viewBox="0 0 w h"`) and the viewer rewrites a single CSS `transform` on its root element
once per drawn frame. Shapes are not recomputed per frame, and `vector-effect:
non-scaling-stroke` keeps borders and markers crisp at every zoom level, so a continuous
pan stays smooth instead of stuttering.

**The overlay is portaled into OpenSeadragon's canvas.** OpenSeadragon binds its pointer
tracker to `.openseadragon-canvas`; an overlay mounted as a sibling would swallow drags and
wheel events. Being a descendant, every gesture bubbles to the tracker and pan/zoom keeps
working while objects are drawn on top.

**Large image overlays get their own pyramid.** An uploaded overlay asset is tiled into a DZI
pyramid (PNG, to preserve alpha) and rendered from that pyramid, so a detailed overlay keeps
its source resolution at deep zoom instead of being downsampled to a single bitmap. Each
layer keeps an independent tile source.

**Validation happens on the server, and it is real.** The upload path decodes the file and
compares the decoded format with the declared MIME type, so a renamed `.exe` cannot enter the
pipeline. Geometry is checked against the image's actual pixel bounds, and style values are
clamped to known keys and ranges.

**Ownership is enforced in the service layer.** Every layer and object mutation resolves the
owning image first, so a client can never modify a layer that belongs to another image.

---

## 12. License

Private project. All rights reserved.
