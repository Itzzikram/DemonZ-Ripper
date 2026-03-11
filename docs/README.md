# DemonZ Ripper

Rip 3D models from **Fab.com** and any **WebGL-powered** site. Extracts meshes, textures, shaders, and geometry into GLB, glTF, OBJ, or Unreal Engine UAsset format.

---

## Architecture

```
┌──────────────────────┐
│   Ripper UI (React)  │  ← http://localhost:5174
│   Vite + Dark Neon   │
└──────────┬───────────┘
           │ /api proxy
┌──────────▼───────────┐
│  Rip Orchestrator    │  ← http://localhost:4010
│  Fastify + Puppeteer │
│  ┌─────────────────┐ │
│  │ Headless Chrome  │ │
│  │ WebGL Hook →     │ │
│  │ Draw Calls →     │ │
│  │ GLB Export       │ │
│  └─────────────────┘ │
└──────────────────────┘
```

## Project Structure

```
demonz-ripper/
├── apps/
│   └── ripper-ui/            # React UI (Vite, Dark Neon theme)
│
├── packages/
│   ├── webgl-ripper/         # WebGL2 hook, capture, scene reconstruction
│   ├── export-formats/       # GLB, glTF, OBJ, UAsset exporters
│   └── shared-utils/         # Logger, EventBus, math, types
│
├── services/
│   └── rip-orchestrator/     # Fastify API + Puppeteer headless browser
│
├── infrastructure/
│   ├── docker/               # docker-compose, Dockerfiles, nginx
│   ├── kubernetes/           # K8s deployments + ingress
│   └── terraform/            # AWS S3 + CloudFront
│
└── docs/                     # Documentation
```

## Quick Start

```bash
# Install
npm install

# Terminal 1 — Backend
cd services/rip-orchestrator
npx tsx src/index.ts

# Terminal 2 — Frontend
cd apps/ripper-ui
npm run dev
```

Open **http://localhost:5174**, paste a Fab.com URL (with 3D Viewer), select format, and hit **⚡ Rip**.

## Export Formats

| Format | Extension | Use Case |
|--------|-----------|----------|
| GLB | `.glb` | Universal, single-file binary glTF |
| glTF | `.gltf` + `.bin` | Editable JSON + separate binary |
| OBJ | `.obj` + `.mtl` | Legacy compatibility |
| UAsset | `.uasset` + `.uexp` | Unreal Engine import |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite |
| Backend | Node.js, Fastify, Puppeteer |
| Capture | WebGL2 API interception |
| Export | glTF 2.0, OBJ, UAsset binary |
| Infra | Docker, Kubernetes, Terraform |
