# `pierreangulaire`

A medical 3D imaging library for the browser, implemented entirely in TypeScript.

---

## 0. Philosophy

- This lib works hard so implementers don't have to. The domain is complex but pierreangulaire must not be complicated.
- We only depend on other libraries if absolutely necessary.
- Coverage % must never go down.
- The best code is no code, we follow the KISS principle.
- Never leave room for things that don't exist yet. Every method should be used.

## 1. Scope

- 3D viewport only. A viewport shows **exactly one** grayscale image volume, plus **zero or one** segmentation volume.
- The camera is always orthographic. A viewport renders a slab of arbitrary orientation (axial / sagittal / coronal / oblique) and arbitrary thickness, accumulated by a blend mode: a thin slab yields a single slice, a thick slab yields a projection through the volume.
- Image volumes are grayscale. Appearance is controlled by window/level only.
- Segmentations are voxel-wise (labelmap) only.
- Loading and rendering are always progressive.
- Camera tools: pan, zoom, rotate (3D pivot tool), window/level, slab scroll, crosshairs.
- Annotation tools: length, angle, bidirectional, arrow, rectangle ROI, probe.
- Segmentation creation tool : Box prompt tool, Point prompt tool. those use a callback function, the caller implements the segmentation action
- Segmentation editing tools: brush, eraser.

The scope is tight and no extra feature should be extrapolated

---

## 2. Core concepts

| Concept             | Definition                                                                                                                                                                       | Cardinality                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Volume**          | A 3D grid of scalar voxels plus geometry (dims, spacing, origin, direction). Grayscale image data.                                                                               | Loaded once, shared across viewports.                 |
| **Segmentation**    | A 3D label volume co-registered to an image volume's grid. Voxel-wise. Supports overlap. Built in: created and destroyed with its image volume, never managed by the consumer.   | Exactly one per image volume (1:1, always present).   |
| **Viewport**        | A view onto one image volume (and that volume's built-in segmentation, visibility toggleable): orthographic camera at any orientation, slab thickness, blend mode, window/level. | One per canvas.                                       |
| **RenderingEngine** | Owns the active renderer, the renderer-agnostic scene / brick store, the canvas registry, and the render loop.                                                                   | Singleton — exactly one for the application lifetime. |
| **Renderer**        | Turns scene + brick store into pixels on each viewport canvas, behind a swappable interface. `GPURenderer` (WebGPU) today; `CPURenderer` (software) planned.                     | One active per RenderingEngine.                       |
| **Brick**           | A fixed-size cubic block of voxels (default 32³). Unit of allocation, streaming, and upload.                                                                                     | Many per volume.                                      |

A viewport references one image volume directly; that volume's built-in segmentation is rendered when visible.

---

## 3. Architecture

The library is a single TypeScript stack in three layers, top to bottom:

1. **Application / public API** — the `RenderingEngine`, the viewports, the tools, the SVG overlay, the loaders and decode workers, and the `requestAnimationFrame` render loop. This is the surface consumers touch and the only layer that handles the DOM and input.
2. **Renderer-agnostic state** — the single source of truth, held in plain TypeScript objects: the scene, the CPU-resident brick store (image and segmentation voxels as brick pool + page table), the camera, the 256-entry label table, and per-viewport window/level, blend mode, and slab thickness.
3. **Renderer** — a swappable interface with exactly one active implementation, which turns the state above into pixels on each viewport canvas. Either the `GPURenderer` (WebGPU; the implemented backend, mirroring bricks into GPU textures and drawing via WGSL slab-raycast pipelines) or the `CPURenderer` (a worker-pool software raycaster that reads the brick store directly and blits pixels to the canvas; planned).

The application layer drives the render loop and pushes state changes down; each frame it asks the active renderer to redraw the dirty viewports by id. Everything flows down through the renderer interface.

### 3.1 Layer responsibilities

Everything is TypeScript. Responsibilities split between the renderer-agnostic core, the active renderer, and the application layer.

**Renderer-agnostic core** owns the single source of truth:

- The scene and the CPU-resident **brick store** — the authoritative voxel data for every volume and segmentation (bricked), the page tables, and the 256-entry label table.
- Camera state, window/level, blend mode, and slab thickness.
- Voxel-write operations for segmentation editing, and on-demand voxel sampling.

**Renderer** (behind a swappable interface, §14) turns that state into pixels on each viewport canvas. Two implementations:

- **`GPURenderer` (WebGPU)** — the only implemented backend. Owns a single `GPUDevice`/`GPUQueue`, one canvas context per viewport canvas (rendering targets each canvas directly), the WGSL slab-raycast pipelines and all draw submission, and the GPU-side mirror of brick/segmentation data (textures) plus camera matrices derived from the core's camera state.
- **`CPURenderer` (software)** — planned. A software slab raycaster in a Web Worker pool; reads bricks from the core's store directly, writes RGBA, and blits to each canvas. Implements the same interface and must produce pixel-consistent output.

**Application layer** owns:

- The DOM: canvas elements, resize observers, the render loop (`requestAnimationFrame`).
- All pointer / wheel / touch events and their normalization.
- All tools (camera, annotation, segmentation editing).
- The annotation overlay (SVG), stacked above the renderer's canvas.
- Coordinate transforms (world↔canvas) computed synchronously from the one camera state.
- Volume/segmentation loading orchestration and decode workers.
- The public, ergonomic API.

### 3.2 Renderer contract

The core holds state; the active renderer is asked to (re)draw given viewports and is notified of state changes. This contract is what makes renderers swappable.

- **On load (streamed):** full image slices written into the brick store, one by one. The `GPURenderer` mirrors new/dirty bricks into GPU textures; the `CPURenderer` reads them in place.
- **On interaction:** camera, window/level, blend mode, slab thickness, segmentation visibility, and label-table changes are pushed to the renderer.
- **Per frame:** a render signal carrying only viewport identifiers.
- **On demand:** single-voxel sampling for probes and measurements, served from the brick store.

State lives in TypeScript objects the renderer reads; the only process boundary is main-thread ↔ Web Workers (decode, and the `CPURenderer`'s raycast pool), crossed with transferable buffers.

---

## 4. Geometry & coordinate systems

A volume defines the mapping from voxel index space to patient/world space.

- **Index space**: integer voxel coordinates `(i, j, k)`.
- **World space**: millimeters, derived from `origin + direction * (index .* spacing)`.
- **Canvas space**: pixels in a viewport's canvas.

A segmentation shares the geometry of its image volume. Image and segmentation are sampled with identical coordinates by the renderer. Inputs not on the image grid are resampled to it at ingest.

---

## 5. Volume model & progressive loading

### 5.1 Brick pool & page table

Every volume (image and segmentation) is stored as bricks in a renderer-agnostic, CPU-resident **brick store** — the authoritative voxel data. Each renderer derives its own representation from it.

- **Brick**: cubic block, default 32³ voxels.
- **Page table**: a small indirection structure, one entry per brick. Each entry encodes brick state and, when resident, its slot in the brick pool.
- **Brick pool**: the packed store of resident (non-empty / loaded) bricks. The `GPURenderer` realizes it as a 3D atlas texture; the `CPURenderer` reads the CPU brick arrays directly.

A sample is resolved as: world → index → brick coordinate → page-table lookup → pool offset → voxel fetch. Empty/absent bricks contribute nothing and are skipped by the raymarcher.

Each brick is in one of three states: **Absent**, **Loading**, or **Resident**.

The same page table serves four purposes: sparse storage, progressive load status, empty-space skipping during raycast, and dirty-region sync after edits (re-upload to GPU textures, or direct re-read on CPU).

Alongside the page table, each image brick carries a **value range** (min/max of its voxels), computed once when the brick becomes Resident. This is the acceleration structure for empty-space skipping during raycast (§7.2): because a brick's contribution depends on the current window/level and blend mode — air is signal in MinIP, background in a soft-tissue composite — the range is tested per frame against the live view state. It is a skip _hint_ layered over full storage: every voxel is always stored, so switching blend mode or window never loses data.

### 5.2 Two-phase volume lifecycle

Geometry is known before voxel data (from headers), so allocation precedes fill. A volume is created from its geometry and voxel format; it is allocated in the brick store and renderable from the first frame (the `GPURenderer` allocates the matching GPU textures). Full slices are then written one by one — each a complete plane along the acquisition axis — as the loader delivers them.

Renders run against partially-filled volumes. A brick becomes **Resident** once all slices spanning it have arrived; regions whose slices have not yet arrived are **Absent** and render as empty.

### 5.3 Progressive arrival

Progressive means slices arrive **in full, one by one**, each at native resolution: the loader hands the engine complete slices, in any order, and each is written on arrival. The volume fills along the acquisition axis as its slices land; bricks flip to **Resident** band by band and become visible as soon as they complete.

### 5.4 Scheduler

Slice requests are prioritized by current viewport state:

- **Thin slab**: the slices intersecting the active slab first, then outward along the `normal` vector.
- **Thick slab**: the slices spanning the slab first, then the rest of the volume in order.

The scheduler is told which viewport has priority, accepts prioritized slice requests, and notifies on each slice's arrival. On arrival the affected viewports are flagged dirty and re-rendered once per frame (arrivals are coalesced).

---

## 6. Segmentation model

Every image volume owns **exactly one** segmentation, created automatically when the volume is created and destroyed with it, reached through the owning volume, and always present. Because storage is sparse (§5.1), an untouched segmentation allocates no bricks and costs effectively nothing until painted.

### 6.1 Representation

A segmentation supports up to **256 distinct segment indices** (1–255; 0 = empty) and an **overlap depth** of K segments per voxel (default 4).

Each voxel stores a **set of up to K segment indices** ("slots"), each a `u8`:

| K (overlap depth) | Texture format | bytes/voxel | distinct labels |
| ----------------- | -------------- | ----------- | --------------- |
| 4                 | `rgba8uint`    | 4           | 256             |

Slots store the **full set** present at a voxel. Segmentation textures are point-sampled. Segmentations use the same brick pool + page table as image volumes, so they are sparse: only bricks containing segmented voxels are allocated.

### 6.2 Label table

A 256-entry table holds per-segment style — color (rgb), fill opacity, and visibility — shared across all viewports showing the segmentation. The segmentation exposes its owning volume, an editor, and the means to read and write label styles and to list the segments currently present.

### 6.3 Compositing rule

**Projection along the ray.** The overlay is a **projection** of the slab: marching the slab collects the **set of distinct visible segments** encountered anywhere along the ray, and each collected segment contributes **exactly once** to the pixel. A segment's rendered opacity is therefore independent of slab thickness — a 20% fill reads as 20% whether the slab crosses the segment at one sample or three hundred. The per-ray set is capped at **8 distinct segments**, kept in front-to-back encounter order (later segments are dropped); hidden segments never consume a slot.

**In-plane styling.** Each projected segment renders as a **quasi-opaque border with a transparent fill**, evaluated on the segment's projected footprint in the view plane: a pixel within the border width of the footprint's boundary (an in-plane neighbor at that distance lacking the segment) contributes at near-full opacity (α ≈ 0.9), interior pixels at the segment's label opacity. The border width is a fixed number of voxels (default 1.25, matched to the anti-aliased outline thickness so the two modes read alike), widened to at least one on-screen pixel when zoomed out so borders never vanish. Segments blend **additively**: each contributing segment adds its premultiplied color (`color × α`), the summed color is clamped, and coverage accumulates as `1 − Π(1 − αₛ)`. Where segments overlap the sums brighten and shift hue, so overlap is directly visible. The combined color is blended over the grayscale by the accumulated coverage; a pixel whose ray crosses only hidden (or no) segments gets no overlay.

Full storage of the slot set is what allows a segment to be erased or hidden and the remaining segments to keep rendering. The compositing function is isolated, so it's easy to replace later.

**Antialiasing** is a per-viewport toggle (default on, §9). With it off, membership is the point-sampled projected footprint and both the silhouette and the border follow the voxel grid. With it on, each segment's coverage is computed by **low-pass filtering its projected membership with a compact, smooth 2D kernel in the view plane, wider than a voxel**; the smooth coverage in `[0, 1]` then drives **both** boundaries of the drawn segment as isocontours, so neither follows the voxel grid — at the cost of slightly rounding sub-voxel features. The outer silhouette is the coverage `0.5` contour (segment vs. background); the inner edge of the quasi-opaque outline is a **higher isocontour** (a fixed step deeper in coverage), which sits a roughly constant distance inside the boundary. Because both edges are `smoothstep` transitions of the same continuous coverage field, the border is anti-aliased on its outer _and_ inner edge. The kernel is **anchored to the voxel grid** (centred on the in-plane projection of the nearest voxel, taps spaced one in-plane voxel step apart) and weights each tap by a smooth function of its continuous in-plane distance to the sample point that falls to zero at the window edge; this makes the coverage field continuous as the sample point moves across the screen, which is what removes the staircase. The transition width of each contour tracks the on-screen pixel footprint, so edges stay crisp, roughly one pixel wide, at any zoom. In this mode the outline width is set by the gap between the two isocontours. Antialiasing changes only appearance, never the stored slot sets, and it costs extra fetches in the overlay resolve pass (§7.2), so it can be toggled off.

### 6.4 Editing

Editing operations write voxel slot sets into the CPU-resident brick store, then mark the affected bricks dirty; the active renderer syncs them — the `GPURenderer` re-uploads only dirty bricks, the `CPURenderer` reads them in place.

- **Paint segment `s`** over a brush region: allocate brick if **Absent**; add `s` to each voxel's slot set (fill an empty slot).
- **Erase segment `s`**: clear the slot holding `s`. The remaining segments render automatically.
- **Slots full** (a (K+1)th overlap at a voxel): evict the lowest index (default policy).
- **Undo/redo**: snapshot dirty bricks before a stroke; restore at brick granularity.

The editor carries an active segment, paints and erases over a brush region (sphere or circle), groups writes into undoable strokes, and supports undo/redo.

---

## 7. Rendering

### 7.1 Renderers

Rendering goes through a swappable `Renderer` interface (§14). The `RenderingEngine` holds exactly one active renderer, chosen at init.

- **`GPURenderer` (WebGPU)** — the implemented backend. One `GPUDevice` / `GPUQueue` per application; one canvas context per viewport canvas, rendering targets each canvas directly; WGSL pipelines.
- **`CPURenderer` (software)** — planned. A software slab raycaster in a Web Worker pool, blitting pixels to each canvas. Same `Renderer` contract.
- The two tiers are WebGPU where a usable GPU is present, and the CPU renderer where it is not.
- Compute-dependent fast paths (gradient precompute, histogram-based auto window/level) are `GPURenderer`-only; the `CPURenderer` will provide CPU equivalents.

### 7.2 Pipeline

One algorithm in two passes: an **orthographic slab raycast** followed by a **screen-space overlay resolve**. In the raycast pass, parallel rays are cast along the `normal` vector and marched from the near slab plane to `near + slabThickness`, accumulated by the blend mode; grayscale is mapped via window/level. The same march projects the segmentation (§6.3): each sample contributes one point-sampled slot-set fetch, merged into the ray's set of up to 8 distinct visible segments, written alongside the grayscale to a screen-size integer target (`rg32uint`, 8 packed indices per pixel). The resolve pass then evaluates the compositing rule on that projected buffer — border test, optional antialiasing, additive blending — **once per pixel, in 2D**, and blends the overlay over the grayscale; it is skipped entirely when the segmentation is hidden. Overlay cost is therefore independent of slab thickness: the neighborhood work (border test, antialiasing kernel) never multiplies with the sample count. Absent/empty bricks are skipped; gradient-based shading is optional. Both renderers implement this same algorithm — the `GPURenderer` as WGSL pipelines, the `CPURenderer` as CPU kernels — and must produce pixel-consistent output (enforced by golden-image cross-tests).

**Empty-space skipping.** For thick-slab and full-volume modes, marching every sample is dominated by trilinear fetches through regions that cannot affect the result. Each sample first consults its brick's value range (§5.1, cached across consecutive samples in the same brick — one lookup per brick boundary crossed) and skips the trilinear fetch when the brick cannot change the pixel under the current view state: for MIP when the brick max is at or below the running maximum, for MinIP when the brick min is at or above the running minimum, for Composite when the brick max maps below the window low (contributes zero). Average visits every sample (the mean depends on all of them). The skip never changes output: a value the gate skips at a brick boundary is captured where the ray passes through the brick that actually holds it.

**Brick leaping.** When a brick can affect neither the image (its value-range gate is closed for the current mode, or Composite opacity has saturated — never in Average) nor the overlay (segmentation hidden, brick unoccupied, or the per-ray segment set already full), the march does not step through it sample by sample: the ray's exit from the brick is computed analytically and iteration resumes at the sample just before the exit, so a skipped brick costs a few iterations instead of one per sample. The landing bias of one sample guarantees floating-point error can never jump past a sample the per-sample gates would have processed — leaping visits exactly the samples the gates would have accepted, so it never changes output. It is disabled by the empty-block debug toggle (§9), which walks every sample to draw brick outlines.

**Segmentation-space skipping.** The same per-brick texel carries a segmentation occupancy flag, dilated by one brick so the point-sampled fetch (which rounds to the nearest voxel) can never reach a labeled voxel from a brick marked empty. Samples in unmarked bricks skip the segmentation fetch entirely — most of a thick-slab ray crosses unlabeled space. A ray whose segment set is already full (8 distinct segments) also stops fetching. Like the value-range gate, this never changes output.

**Ray clipping.** Before marching, the sample index range where the slab segment overlaps the volume bounds is computed analytically. Rays that miss the volume return background immediately, and the portions of a thick slab outside the volume are never iterated.

**Early ray termination.** In Composite, image accumulation stops once accumulated opacity saturates — deeper samples cannot change the grayscale. When the segmentation overlay is visible the ray keeps marching without image fetches so an in-front opaque structure never clips a segment projected from behind it; the ray terminates early only once the per-ray segment set is also full.

These optimizations target the marching-heavy thick-slab and full-volume paths and cost thin-slab views (the default, ~1 sample per ray) nothing.

Sample count per ray scales with slab thickness at the volume's voxel pitch **along the ray** — one sample per index-space step in the slab direction, so anisotropic volumes are not oversampled along their coarse axes and arbitrarily deep stacks are never undersampled. The count is uncapped: ray clipping bounds the marched range to the volume overlap, so per-ray work is bounded by the volume's extent along the ray. One pipeline spans the full range of views:

| orientation          | slab thickness | blend                 | result                        |
| -------------------- | -------------- | --------------------- | ----------------------------- |
| axis-aligned         | ~1 voxel       | any                   | single slice                  |
| oblique (any normal) | ~1 voxel       | any                   | oblique reslice               |
| any                  | medium         | MIP / MinIP / Average | thick-slab projection         |
| any                  | full volume    | MIP                   | full MIP                      |
| any                  | full volume    | Composite             | orthographic volume rendering |

### 7.3 Blend modes

Composite, MIP, MinIP, and Average. Blend mode and slab thickness are viewport-level properties.

### 7.4 Window/level

The image appearance is window/level only (window width and window center), applied in-shader as a linear ramp into grayscale.

### 7.5 Render loop

The loop lives in TypeScript. Viewports carry dirty flags. Each frame, the `RenderingEngine` renders the dirty viewports through the active renderer — the `GPURenderer` records one command buffer per dirty canvas and submits; the `CPURenderer` raycasts each dirty viewport in its worker pool and blits the result. Brick arrivals and state changes set dirty flags. The loop is stopped on engine teardown (§10).

---

## 8. Camera

The camera is always orthographic.

- **Orientation**: preset axes (axial, sagittal, coronal, acquisition) or an arbitrary oblique `normal`.
- **State** — the bare-minimum set that is stored and reapplied as-is (7 degrees of freedom):

  | Field        | Type     | Meaning                                                                        |
  | ------------ | -------- | ------------------------------------------------------------------------------ |
  | `normal`     | `vec3`   | Unit vector ⊥ the view plane — the look / ray-march direction.                 |
  | `up`         | `vec3`   | Unit vector ⊥ `normal` — screen up (roll). `right = normalize(normal × up)`.   |
  | `focalPoint` | `vec3`   | World-space point (mm) at the canvas center — supplies in-plane pan and depth. |
  | `zoom`       | `number` | Orthographic zoom (world mm per viewport half-height).                         |

  A `position` is derivable as `focalPoint + normal * d` for any `d` (the rendered image is invariant to camera translation along `normal`), and the slab center is `focalPoint` projected onto `normal`.

- **Slab navigation**: relative scrolling along the `normal` vector is an _operation_ that moves `focalPoint` along `normal`; the slab center is therefore read from `focalPoint`.

Camera state lives in TypeScript as the single source of truth. It computes world↔canvas transforms synchronously for the overlay, and the active renderer derives the view and orthographic-projection matrices from the same state.

---

## 9. Viewport

A viewport is bound to one canvas and one image volume, and exposes:

- A camera (§8).
- Visibility toggle for the volume's built-in segmentation.
- Antialiasing toggle for the segmentation (§6.3).
- Empty-block debug toggle (default off): draws a pink wireframe around the edges of bricks with no in-window content — the empty space the raycast skips (§7.2) — and disables early ray termination and brick leaping so the whole skipped structure is visible. Diagnostic only.
- Window/level, blend mode, and slab thickness.
- Synchronous world↔canvas coordinate transforms (computed TS-side).
- On-demand single-voxel sampling (reads the CPU-resident brick store).
- Resize and render.

---

## 10. RenderingEngine

There is exactly one `RenderingEngine` for the lifetime of the application, reached through a module-level accessor that always returns the same instance. Initialization happens once before first use; calling it again is a no-op.

- **Options**: renderer selection (`GPURenderer` / `CPURenderer`; default auto — `GPURenderer` when WebGPU is available, otherwise `CPURenderer`), brick size (default 32), and segmentation overlap depth K (default 4, optionally 8).
- **Volumes**: created from geometry and a voxel format (Int16, Uint16, Uint8, or Float32); each volume exposes its geometry, format, built-in segmentation, slice writes, and a slice-loaded query. Destroying a volume releases its brick store and the renderer's mirror of it; a volume still referenced by a live viewport cannot be destroyed — destroy the viewport first.
- **Viewports**: created, looked up, and destroyed through the engine.
- **Scheduler**: owned by the engine (§5.4).
- **Render**: a single entry point that renders the given viewports, or all dirty ones when unspecified.
- **Teardown**: destroying the engine stops the render loop, releases every viewport and volume, tears down the active renderer (the `GPURenderer` destroys its device), and resets the singleton so a later init starts fresh.

---

## 11. Tools

Tools are TypeScript. They consume normalized interaction events and call viewport / editor / overlay APIs.

Tool activation is **global**. A tool is registered once and is in exactly one state — active (bound to a mouse button / modifier and handling new gestures), passive (existing annotations stay interactive but no new gestures start), or disabled — for the whole application. That state applies to every viewport.

### 11.1 Camera tools

| Tool              | Action                                                 |
| ----------------- | ------------------------------------------------------ |
| `PanTool`         | Translate camera in-plane.                             |
| `ZoomTool`        | Adjust `zoom` (orthographic zoom).                     |
| `RotateTool`      | Rotate the `normal` vector (oblique reslice).          |
| `WindowLevelTool` | Drag to adjust window/level.                           |
| `SlabScrollTool`  | Scroll the slab position along the `normal` vector.    |
| `CrosshairsTool`  | Linked navigation across viewports of the same volume. |

### 11.2 Annotation tools

| Tool                | Output                                           |
| ------------------- | ------------------------------------------------ |
| `LengthTool`        | Distance in mm between two world points.         |
| `AngleTool`         | Angle between three world points.                |
| `BidirectionalTool` | Long + short perpendicular axes.                 |
| `ArrowTool`         | Arrow pointing at a world point, optional label. |
| `RectangleROITool`  | Rectangular ROI, statistics from voxel sampling. |
| `ProbeTool`         | Single-point voxel value.                        |

Annotations are stored as world-space geometry and rendered to the SVG overlay via the world→canvas transform.

### 11.3 Segmentation editing tools

| Tool         | Action                                       |
| ------------ | -------------------------------------------- |
| `BrushTool`  | Paint the active segment in a sphere/circle. |
| `EraserTool` | Clear the active segment in a region.        |

These call the segmentation editor, which writes voxel slots and triggers dirty-brick upload.

### 11.4 Segmentation creation (prompt) tools

These tools capture a prompt gesture and hand it to a caller-supplied callback. The callback (e.g. a model inference call) performs the segmentation and writes voxels through the editor it is given.

| Tool              | Gesture                                                       |
| ----------------- | ------------------------------------------------------------- |
| `BoxPromptTool`   | Drag a 3D box; emits its world-space bounds.                  |
| `PointPromptTool` | Click foreground/background points; emits the labeled points. |

The callback receives the prompt geometry (box bounds, or labeled points) together with the target segmentation editor.

---

## 12. Overlay & event layers

- **OverlayLayer**: an SVG element positioned over each viewport's render canvas. Renders annotations, cursors, reference lines, and text. Redrawn on camera change and on annotation change. Segmentations render through the volume pipeline.

- **Event layer**: listens to native pointer/wheel/touch on the canvas, produces a normalized event (viewport id, canvas point, world point, buttons, modifiers), and dispatches to whichever active tool matches the event's binding.

---

## 13. Events

The library fires events for every action the caller may want to react to.

---

## 14. Renderer interface

Renderers are swappable behind a single interface; nothing above it depends on WebGPU. An implementation receives the renderer-agnostic state (scene, brick store, page tables, label table, camera, per-viewport view state) and is responsible only for producing pixels.

The interface groups into: lifecycle (initialize; volume created / destroyed; register / resize / destroy a viewport canvas; destroy the renderer itself); state-sync notifications (brick uploaded / dirtied, label-table edit, and camera / window-level / blend / slab / segmentation-visibility changes); and render (draw the given viewport ids). The `GPURenderer` implements it against WebGPU — mirroring bricks into GPU textures, WGSL pipelines, one canvas context per viewport. The `CPURenderer` (planned) implements it as a worker-pool software raycaster reading the brick store directly. Identifiers are plain string ids / object references.

The rest of the engine surface is ordinary TypeScript: viewport lifecycle; volume create and destroy plus slice writes and slice-loaded queries (volume creation also allocates the built-in segmentation); segmentation access by owning volume, label edits, paint / erase, stroke grouping, and undo / redo; viewport state setters (attached volume, segmentation visibility, camera, window/level, blend mode, slab thickness); and on-demand voxel sampling.

---

## 15. Browser & runtime requirements

- WebGPU where a usable GPU is available (`GPURenderer`); a CPU software renderer (`CPURenderer`, planned) where it is not.
- Compute-dependent features (gradient precompute, histogram auto window/level) are a `GPURenderer` fast path; the `CPURenderer` will provide CPU equivalents.
- The `GPURenderer`'s device/context/present run on the main thread. The `CPURenderer` runs in a Web Worker pool. Decode and heavy voxel operations run in Web Workers.
- The host supplies fully decoded image slices.

---

## 16. Project layout & tooling

The library ships as a single ESM-only package, `pierreangulaire`, targeting modern browsers (build target `es2022`). It is a pnpm workspace: the library lives at the repo root, with a `playground/` Vite app as a workspace member for manual rendering tests.

```
pierreangulaire/
├── src/index.ts        public API entry (the only published source)
├── test/               Vitest suites
├── playground/         private Vite app; imports the library via a source alias
├── tsdown.config.ts    library build
├── tsconfig.json       strict, browser libs (DOM, WebWorker, @webgpu/types)
├── vitest.config.ts    test runner
├── .oxlintrc.json      lint config
├── .oxfmtrc.json       format config
└── lefthook.yml        git hooks
```

| Concern    | Tool                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| Runtime    | Node `>=24`, pnpm 10                                                     |
| Build      | `tsdown` (Rolldown) → ESM + bundled `.d.ts`, `platform: browser`         |
| Type-check | `tsc --noEmit`, `strict` + `noUncheckedIndexedAccess`                    |
| Lint       | `oxlint`                                                                 |
| Format     | `oxfmt`                                                                  |
| Tests      | `vitest` (Node environment; browser mode to be added for renderer tests) |
| Git hooks  | `lefthook` — pre-commit runs `oxfmt --check` + `oxlint` on staged files  |

The published artifact is `dist/` (`index.js` + `index.d.ts`); only `src/` is shipped as source of truth. The playground resolves the `pierreangulaire` import to `src/index.ts` directly, so it renders against live source with no build step.

---

## 17. Defaults

| Parameter                      | Default                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| Renderer                       | Auto — `GPURenderer` (WebGPU) when available; `CPURenderer` planned |
| Brick size                     | 32³ voxels                                                          |
| Segmentation overlap depth (K) | 4 (`rgba8uint`)                                                     |
| Distinct segment indices       | 256 (1–255; 0 = empty)                                              |
| Overlap compositing            | Additive — every visible segment contributes                        |
| Segment border                 | Quasi-opaque (α ≈ 0.9), 1.25 voxels wide, in the view plane         |
| Segment fill opacity           | 0.2 (per-segment, from the label table)                             |
| Segmentation antialiasing      | On (per-viewport, toggleable)                                       |
| Slot overflow policy           | Evict lowest index                                                  |
| Segmentation sampling          | Nearest (point)                                                     |
| Segmentation visibility        | Visible (per viewport, toggleable)                                  |
| Image sampling                 | Linear                                                              |
| Loading                        | Progressive, full slice by slice, always                            |
| Projection                     | Orthographic, always                                                |
| Default slab thickness         | One voxel (thin slab)                                               |

---

## 18. Implementation status

The codebase currently implements the **minimal grayscale rendering path** end to end — load a volume from geometry, stream its slices, and render it in orthographic slab viewports through the `GPURenderer` — plus the **segmentation model and its rendering**. Everything below conforms to the model defined above; the rest of the surface is not built yet.

### 18.1 Implemented

- **Geometry & coordinates** (§4): `VolumeGeometry` with index↔world transforms.
- **Brick store** (§5.1–5.3): page table with `Absent` / `Loading` / `Resident` states, progressive slice writes flipping bricks resident band by band, dirty-brick tracking, and on-demand voxel sampling.
- **Volume** (§5.2): two-phase lifecycle (geometry first, slices streamed), slice writes, slice-loaded query.
- **Camera** (§8): orthographic camera (`normal`, `up`, `focalPoint`, `zoom`), `axial` / `coronal` / `sagittal` / `acquisition` presets, synchronous world↔canvas transforms, slab scroll along `normal`.
- **Viewport** (§9): one canvas + one volume, window/level, blend mode, slab thickness, voxel sampling.
- **RenderingEngine** (§10): singleton module accessor + one-time async init, `createVolume` / `createViewport`, volume and viewport destruction (a volume referenced by a live viewport is rejected), full engine teardown (stops the loop, releases resources, destroys the renderer, resets the singleton), and a `requestAnimationFrame` loop that uploads dirty bricks and redraws dirty viewports.
- **GPURenderer** (§7, §14): WebGPU orthographic slab raycast in WGSL, one canvas context per viewport, per-brick texture upload.
- **Blend modes** (§7.3): MIP, MinIP, Average. Composite is a basic front-to-back accumulation (grayscale used as opacity).
- **Empty-space skipping, segmentation-space skipping & early ray termination** (§5.1, §7.2): a small `rgba32float` 3D texture (one texel per brick) carries the per-image-brick min/max value range, computed on residency, plus a segmentation occupancy flag dilated by one brick, maintained on segmentation upload; the range gates the per-sample trilinear fetch per blend mode against the live window/level, the occupancy flag gates all segmentation sampling, and rays are clipped analytically to the volume bounds before marching. When a brick is gated on both counts the ray leaps to its exit instead of stepping through it (§7.2). Composite additionally stops image accumulation once opacity saturates and terminates the ray once the per-ray segment set is also full. A per-viewport **empty-block debug toggle** (§9) draws these skipped bricks as a pink wireframe.
- **Segmentation** (§6.1–6.2): built-in 1:1 segmentation per volume with K=4 slot sets, sphere paint writes with slot-overflow eviction (lowest index), present-segment listing, a 256-entry label table (color / opacity / visibility, versioned), and dirty-brick sync through the renderer contract.
- **Segmentation rendering** (§6.3): point-sampled slot sets composited in the raycast shader — quasi-opaque border (1.25 voxels wide) where an in-plane neighbor lacks the segment, transparent fill inside, every visible segment blended additively, accumulated front-to-back along the slab and blended over the grayscale sample — with per-viewport visibility and antialiasing toggles (antialiasing derives a smooth silhouette and outline from a grid-anchored, continuous blurred coverage field with a screen-space-adaptive edge, on by default).

### 18.2 Simplifications

- The CPU brick store keeps a **dense** voxel array; the page table tracks residency for streaming and dirty-region upload rather than backing a packed sparse pool.
- The `GPURenderer` mirrors each volume into a single dense **`r32float` 3D texture** (not an atlas); resident bricks are written as texture sub-regions. Image sampling is trilinear, satisfying the Linear default: hardware-filtered through a sampler when the adapter supports `float32-filterable` (one fetch per sample), falling back to a manual 8-tap `textureLoad` reconstruction otherwise. Because a dense volume and the staging for its brick uploads can be large, the device is requested with the adapter's maximum `maxBufferSize` and `maxTextureDimension3D`.
- The segmentation store is likewise a dense slot-set array (4 bytes/voxel); the `GPURenderer` mirrors it into a dense **`rgba8uint` 3D texture** created lazily on the first paint, with the label table in a per-volume uniform buffer re-uploaded when its version changes.
- Voxel writes are exposed directly on the segmentation (sphere paint); the editor abstraction (§6.4 — active segment, erase, stroke grouping, undo/redo) is not built yet.
- The scheduler (§5.4) is not prioritized: arrivals are coalesced into per-frame dirty-brick uploads in slice order.

### 18.3 Not yet implemented

The segmentation editor (§6.4 — erase, stroke grouping, undo/redo) and the editing/prompt tools (§11.3–11.4), all camera/annotation tools and the SVG overlay (§11, §12), events (§13), the prioritized scheduler (§5.4), the `CPURenderer` (§7.1), and the `GPURenderer` compute fast paths — gradient precompute and histogram auto window/level (§7.1, §15).
