# API Reference

## Rip Orchestrator (`services/rip-orchestrator`)

**Base URL:** `http://localhost:4010`

---

### Health

#### `GET /api/health`

**Response:** `200 OK`
```json
{ "status": "ok", "uptime": 12345.67 }
```

---

### Start Rip

#### `POST /api/rip/start`

Start a new rip job.

**Body:**
```json
{
  "url": "https://www.fab.com/listings/some-3d-model",
  "captureTextures": true,
  "captureShaders": true,
  "exportFormat": "glb",
  "captureDuration": 3000,
  "viewportWidth": 1920,
  "viewportHeight": 1080
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | **required** | Target URL with WebGL content |
| `captureTextures` | boolean | `true` | Capture bound textures |
| `captureShaders` | boolean | `true` | Extract GLSL source |
| `exportFormat` | string | `"glb"` | `glb`, `gltf`, `obj`, or `uasset` |
| `captureDuration` | number | `3000` | Capture window in ms |
| `viewportWidth` | number | `1920` | Browser viewport width |
| `viewportHeight` | number | `1080` | Browser viewport height |

**Response:** `200 OK`
```json
{ "jobId": "Lohpj1vcW5cQ" }
```

---

### Job Status

#### `GET /api/rip/status/:jobId`

**Response:** `200 OK`
```json
{
  "id": "Lohpj1vcW5cQ",
  "url": "https://www.fab.com/listings/...",
  "status": "running",
  "progress": 50
}
```

Status values: `queued`, `running`, `complete`, `failed`

---

### Download

#### `GET /api/rip/download/:jobId`

Download the exported file. Returns the file with appropriate `Content-Type`.

**Response:** `200 OK` (binary file)

---

### List Jobs

#### `GET /api/rip/jobs`

**Response:** `200 OK`
```json
[
  {
    "id": "Lohpj1vcW5cQ",
    "url": "https://...",
    "status": "complete",
    "progress": 100,
    "createdAt": "2026-03-06T12:00:00Z",
    "stats": {
      "meshCount": 5,
      "textureCount": 12,
      "shaderCount": 3,
      "drawCallCount": 47,
      "fileSizeBytes": 4194304,
      "captureTimeMs": 2850
    }
  }
]
```

---

### Delete Job

#### `DELETE /api/rip/:jobId`

**Response:** `200 OK`
```json
{ "deleted": true }
```
