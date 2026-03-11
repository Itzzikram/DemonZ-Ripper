# DemonZ Ripper v1.0.0 — Initial Release

**Rip 3D models from Fab.com and any WebGL-powered site.** Extract meshes, textures, shaders, and materials into GLB, glTF, OBJ, or Unreal Engine UAsset format.

---

## Highlights

- **Full WebGL2 Interception** — Captures every draw call, vertex buffer, texture, and shader program via JavaScript Proxy-based API hooking
- **4 Export Formats** — GLB, glTF 2.0, Wavefront OBJ, and Unreal Engine UAsset (.uasset/.uexp)
- **PBR Material Pipeline** — Cook-Torrance BRDF, GGX distribution, IBL, cascaded shadow maps, ACES tone mapping
- **Production-Ready Infra** — Docker Compose, Kubernetes, and Terraform (AWS S3 + CloudFront) deployment options

---

## Features

### WebGL Capture Engine
- WebGL2 API interception via monkey-patched `getContext()`
- Full GL state snapshot per draw call (viewport, blend, depth test, cull face)
- Vertex attribute capture: positions, normals, tangents, UVs, colors, joint weights/indices
- Indexed, non-indexed, and instanced geometry support
- Compressed texture extraction with CORS-aware fallbacks
- Vertex & fragment shader GLSL source extraction
- Scene reconstruction from raw draw calls into structured mesh/material hierarchy

### Export Formats

| Format | Output | Use Case |
|--------|--------|----------|
| **GLB** | `.glb` | Universal single-file binary glTF |
| **glTF 2.0** | `.gltf` + `.bin` | Editable JSON + separate binary |
| **OBJ** | `.obj` + `.mtl` | Legacy compatibility |
| **UAsset** | `.uasset` + `.uexp` + `.ubulk` | Unreal Engine 4/5 import-ready |

- GLB: 4-byte aligned binary packing, accessor min/max bounds, PBR metallic-roughness materials
- UAsset: Binary package header (magic `0x9E2A83C1`), FPackageFileSummary, Name/Import/Export tables, Y-up → Z-up coordinate conversion, UE5 versioning
- OBJ: Material slot grouping, vertex position/normal/UV export

### Ripper UI
- Dark neon-themed React 18 interface
- URL input with Fab.com validation
- Format selector, texture/shader capture toggles, viewport size config
- Real-time job progress tracking
- Asset preview (3D mesh viewer), texture gallery, shader viewer
- Job history and download management

### Rip Orchestrator API
- Fastify 4 REST API with Puppeteer-driven headless Chrome
- Concurrent job queue with configurable parallelism
- Auto-cleanup of stale jobs (5-min timeout)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/rip/start` | POST | Submit rip job |
| `/api/rip/status/:jobId` | GET | Fetch job status |
| `/api/rip/download/:jobId` | GET | Download exported file |
| `/api/rip/jobs` | GET | List all jobs |
| `/api/rip/jobs/:jobId` | DELETE | Cancel job |
| `/health` | GET | Health check |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite 5 |
| Backend | Node.js 20+, Fastify 4.25, Puppeteer 22 |
| Capture | WebGL2 API interception (JS Proxy) |
| Export | glTF 2.0, Wavefront OBJ, UAsset binary |
| Build | NPM Workspaces, Turborepo |
| Infra | Docker, Kubernetes, Terraform (AWS) |

---

## Quick Start

```bash
# Install dependencies
npm install

# Start backend (Terminal 1)
cd services/rip-orchestrator
npx tsx src/index.ts

# Start frontend (Terminal 2)
cd apps/ripper-ui
npm run dev
```

Open **http://localhost:5174**, paste a Fab.com URL, select your format, and hit **⚡ Rip**.

---

## Deployment

- **Docker Compose** — `docker compose -f infrastructure/docker/docker-compose.yml up`
- **Kubernetes** — Ingress with TLS (Let's Encrypt), 300s request timeouts, health checks
- **AWS Terraform** — S3 output storage + CloudFront CDN with 30-day auto-cleanup

---

## Project Structure

```
demonz-ripper/
├── apps/ripper-ui/            # React UI (Vite, Dark Neon theme)
├── packages/
│   ├── webgl-ripper/          # WebGL2 hook, capture, scene reconstruction
│   ├── export-formats/        # GLB, glTF, OBJ, UAsset exporters
│   └── shared-utils/          # Logger, EventBus, math, types
├── services/rip-orchestrator/ # Fastify API + Puppeteer headless browser
├── infrastructure/            # Docker, Kubernetes, Terraform
└── docs/                      # Architecture & API docs
```

---

**Full Changelog**: https://github.com/your-org/demonz-ripper/commits/v1.0.0
