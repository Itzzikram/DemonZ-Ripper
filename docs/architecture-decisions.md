# Architecture Decision Records

## ADR-001: WebGL2 over WebGPU

**Decision:** Use WebGL2 as the primary rendering backend.

**Rationale:**
- WebGL2 has >95% browser support
- WebGPU is still emerging and not universally available
- Production viewers (Sketchfab, etc.) still use WebGL2
- Can add WebGPU backend later without architecture changes

## ADR-002: Custom Engine over Three.js

**Decision:** Build modular rendering packages instead of wrapping Three.js.

**Rationale:**
- Full control over render pipeline for analysis/extraction use cases
- Smaller bundle size — only include what's needed
- Direct WebGL2 access for specialized rendering passes
- Three.js can be optionally used in the viewer-web app layer

## ADR-003: Monorepo with NPM Workspaces

**Decision:** Use NPM workspaces + Turborepo for monorepo management.

**Rationale:**
- All packages share a single `node_modules`
- Turbo handles incremental builds with caching
- Simpler CI/CD than multi-repo approach
- Easy cross-package development

## ADR-004: Fastify over Express

**Decision:** Use Fastify for backend services.

**Rationale:**
- ~3x faster than Express in benchmarks
- Built-in schema validation
- Plugin-based architecture aligns with our modular approach
- First-class TypeScript support

## ADR-005: Prisma for Database Access

**Decision:** Use Prisma ORM for PostgreSQL.

**Rationale:**
- Type-safe queries generated from schema
- Migration system built-in
- Excellent developer experience
- Good performance for our read-heavy workload

## ADR-006: BullMQ for Job Processing

**Decision:** Use BullMQ for model processing job queue.

**Rationale:**
- Redis-backed, horizontally scalable
- Supports retries, concurrency, priority
- Worker-based architecture fits processing pipeline
- Dashboard available for monitoring
