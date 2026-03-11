# Setup Guide

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 20.0 |
| npm | ≥ 10.0 |
| Chrome/Chromium | Latest (for Puppeteer) |

## Installation

```bash
git clone <repo-url>
cd demonz-ripper
npm install
```

## Environment

Copy and edit:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `RIP_ORCHESTRATOR_PORT` | Backend port | `4010` |
| `PUPPETEER_EXECUTABLE_PATH` | Custom Chrome path | auto-detect |
| `CAPTURE_DURATION_MS` | WebGL capture window | `3000` |
| `MAX_CONCURRENT_RIPS` | Parallel rip limit | `2` |
| `OUTPUT_DIR` | Rip output directory | `./output` |

## Running Locally

**Terminal 1 — Backend:**
```bash
cd services/rip-orchestrator
npx tsx src/index.ts
```

**Terminal 2 — Frontend:**
```bash
cd apps/ripper-ui
npm run dev
```

Open **http://localhost:5174**

## Docker

```bash
cd infrastructure/docker
docker compose up -d
```

- **Ripper UI:** http://localhost:3000
- **Rip Orchestrator API:** http://localhost:4010

## Building

```bash
# Build all packages
npm run build

# Type-check only
npm run typecheck

# Run tests
npm test
```

## Kubernetes

```bash
kubectl apply -f infrastructure/kubernetes/
```

## Terraform (AWS)

```bash
cd infrastructure/terraform
terraform init
terraform plan
terraform apply
```

Provisions: S3 bucket (rip output, 30-day auto-cleanup) + CloudFront CDN.
