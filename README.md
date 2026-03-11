# DemonZ Ripper

<p align="center">
  <strong>Rip 3D models from Fab.com and any WebGL-powered site.</strong><br>
  Extract meshes, textures, shaders, and materials into GLB, glTF, OBJ, or Unreal Engine UAsset format.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-cyan" alt="Version">
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-5.3-blue" alt="TypeScript">
</p>

---

## How It Works

```
┌──────────────────────────┐
│    Ripper UI (React 18)  │  ← http://localhost:5174
│    Vite 5 + Dark Neon    │
└────────────┬─────────────┘
             │ /api proxy
┌────────────▼─────────────┐
│   Rip Orchestrator       │  ← http://localhost:4010
│   Fastify 4 + Puppeteer  │
│   ┌────────────────────┐ │
│   │  Headless Chrome   │ │
│   │  WebGL2 Hook ──►   │ │
│   │  Draw Calls  ──►   │ │
│   │  Scene Build ──►   │ │
│   │  Format Export     │ │
│   └────────────────────┘ │
└──────────────────────────┘
```

1. Paste a URL into the UI  
2. Orchestrator launches headless Chrome with WebGL2 enabled  
3. Injected hook intercepts every `drawElements` / `drawArrays` call  
4. Vertex buffers, textures, and shaders are captured in real-time  
5. Scene is reconstructed and exported to your chosen format  

---

## Quick Start

```bash
# Install dependencies
npm install

# Terminal 1 — Backend
cd services/rip-orchestrator
npx tsx src/index.ts

# Terminal 2 — Frontend
cd apps/ripper-ui
npm run dev
```

Open **http://localhost:5174**, paste a Fab.com URL (with 3D Viewer), select your format, and hit **⚡ Rip**.

---

## Export Formats

| Format | Output | Use Case |
|--------|--------|----------|
| **GLB** | `.glb` | Universal single-file binary glTF |
| **glTF 2.0** | `.gltf` + `.bin` | Editable JSON + separate binary |
| **OBJ** | `.obj` + `.mtl` | Legacy compatibility |
| **UAsset** | `.uasset` + `.uexp` | Unreal Engine 4/5 import-ready |

---

## Features

### WebGL Capture Engine
- **Proxy-based interception** — Hooks `getContext()` to intercept all WebGL2 calls without modifying page source
- **Full GL state snapshots** — Viewport, blend mode, depth test, cull face per draw call
- **Vertex attributes** — Positions, normals, tangents, UVs, colors, joint weights/indices
- **Geometry types** — Indexed, non-indexed, and instanced draw calls
- **Texture extraction** — Compressed textures with CORS-aware fallbacks
- **Shader capture** — Vertex & fragment GLSL source code
- **Scene reconstruction** — Raw draw calls → structured mesh/material hierarchy

### Ripper UI
- Dark neon theme (Cyan / Purple / Pink glow aesthetic)
- URL input with validation
- Format selector + capture toggles (textures, shaders)
- Viewport presets: 720p, 1080p, 4K, Mobile
- Real-time progress tracking with phase labels
- Job history with download management
- 3D asset preview, texture gallery, shader viewer

### Rip Orchestrator API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/rip/start` | `POST` | Submit a rip job |
| `/api/rip/status/:jobId` | `GET` | Job status & progress |
| `/api/rip/download/:jobId` | `GET` | Download exported file |
| `/api/rip/jobs` | `GET` | List all jobs |
| `/api/rip/:jobId` | `DELETE` | Cancel a job |
| `/health` | `GET` | Health check |

- Max concurrent rips: **2** (configurable)
- Rate limit: **5 starts/IP/min**
- SSRF protection: blocks private IPs, cloud metadata, internal service ports
- Stale job cleanup with TTL

---

## Project Structure

```
demonz-ripper/
├── apps/
│   └── ripper-ui/                  # React 18 frontend
│       └── src/
│           ├── App.tsx             # App shell + routing
│           ├── pages/
│           │   ├── RipPage.tsx     # Job submission
│           │   └── ResultsPage.tsx # Job history + downloads
│           └── components/
│               ├── AssetPreview.tsx    # 3D mesh viewer
│               ├── TextureGallery.tsx  # Texture browser
│               └── ShaderViewer.tsx    # GLSL source viewer
│
├── packages/
│   ├── webgl-ripper/               # WebGL2 capture engine
│   │   └── src/
│   │       ├── hook/               # getContext() proxy
│   │       ├── capture/            # Draw calls, buffers, textures, shaders
│   │       ├── scene/              # Scene reconstruction
│   │       └── session/            # Capture lifecycle
│   │
│   ├── export-formats/             # Format exporters
│   │   └── src/
│   │       ├── gltf-exporter.ts    # GLB / glTF 2.0
│   │       ├── obj-exporter.ts     # Wavefront OBJ + MTL
│   │       ├── uasset-exporter.ts  # Unreal Engine UAsset
│   │       └── texture-packer.ts   # Image format conversion
│   │
│   └── shared-utils/               # Shared utilities
│       └── src/
│           ├── logger.ts           # Structured logging
│           ├── event-bus.ts        # Pub/sub events
│           ├── math.ts             # Vector/matrix helpers
│           └── types.ts            # Shared TypeScript types
│
├── services/
│   └── rip-orchestrator/           # Backend API
│       └── src/
│           ├── index.ts            # Fastify server entry
│           ├── routes/             # API route handlers
│           └── browser/
│               └── page-loader.ts  # Puppeteer + WebGL hook injection
│
├── infrastructure/
│   ├── docker/                     # Docker Compose + Dockerfiles
│   ├── kubernetes/                 # K8s deployments + ingress
│   └── terraform/                  # AWS S3 + CloudFront
│
└── docs/                           # Documentation
```

---

## Environment Variables

```env
# Rip Orchestrator
RIP_ORCHESTRATOR_PORT=4010

# Puppeteer / Headless Chrome
PUPPETEER_EXECUTABLE_PATH=
CAPTURE_DURATION_MS=3000
MAX_CONCURRENT_RIPS=2

# Output
OUTPUT_DIR=./output
MAX_OUTPUT_SIZE_MB=500

# CORS (defaults to * in dev)
CORS_ORIGIN=*
```

Copy `.env.example` to `.env` and adjust as needed.

---

## Deployment

### Docker Compose

```bash
docker compose -f infrastructure/docker/docker-compose.yml up
```

| Service | Port | Resources |
|---------|------|-----------|
| **rip-orchestrator** | 4010 | 1–2 CPU, 2–3 GB RAM |
| **ripper-ui** | 3000 | 0.25–0.5 CPU, 256–512 MB RAM |

### Kubernetes

- Ingress with TLS (Let's Encrypt via cert-manager)
- 300s request timeouts for long captures
- Health check endpoints configured

### AWS (Terraform)

- S3 bucket for rip output storage
- CloudFront CDN for distribution
- 30-day auto-cleanup lifecycle policy

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite 5 |
| Backend | Node.js 20+, Fastify 4.25, Puppeteer 22 |
| Capture | WebGL2 API interception (JS Proxy) |
| Export | glTF 2.0, Wavefront OBJ, UAsset binary |
| Build | NPM Workspaces, Turborepo |
| Test | Vitest |
| Infra | Docker, Kubernetes, Terraform (AWS) |

---

## License

[Apache License 2.0](../LICENSE)
