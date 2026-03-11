/**
 * BufferExtractor — Intercepts bufferData/bufferSubData to store
 * copies of vertex and index buffer contents.
 *
 * Tracks which ELEMENT_ARRAY_BUFFER is bound to each VAO for correct
 * per-mesh index buffer resolution.
 */

import type { CapturedBuffer, VertexAttribute } from '../types';

export class BufferExtractor {
    private buffers = new Map<number, CapturedBuffer>();
    private attributes = new Map<number, VertexAttribute[]>(); // vaoId → attrs
    private indexBufferPerVao = new Map<number, number>();     // vaoId → bufferId
    private currentVao = 0;
    private boundArrayBuffer = 0;
    private boundElementBuffer = 0;

    /* ---- Buffer data ---- */

    captureBufferData(bufferId: number, target: number, data: ArrayBuffer, usage: number): void {
        this.buffers.set(bufferId, {
            id: bufferId,
            target,
            data: data.slice(0), // defensive copy
            usage,
            byteLength: data.byteLength,
        });
    }

    captureBufferSubData(bufferId: number, target: number, offset: number, data: ArrayBuffer): void {
        const existing = this.buffers.get(bufferId);
        if (!existing) return;

        const subView = new Uint8Array(data);
        // Bounds check: skip if write would exceed existing buffer
        if (offset + subView.byteLength > existing.data.byteLength) return;

        // Merge sub-data into existing buffer
        const view = new Uint8Array(existing.data);
        view.set(subView, offset);
    }

    /* ---- Vertex attribute layout ---- */

    onBindBuffer(target: number, bufferId: number): void {
        if (target === 0x8892 /* ARRAY_BUFFER */) {
            this.boundArrayBuffer = bufferId;
        }
        if (target === 0x8893 /* ELEMENT_ARRAY_BUFFER */) {
            this.boundElementBuffer = bufferId;
            // Track per-VAO element buffer binding (includes VAO 0 for WebGL1)
            this.indexBufferPerVao.set(this.currentVao, bufferId);
        }
    }

    onBindVertexArray(vaoId: number | null): void {
        this.currentVao = vaoId ?? 0;
    }

    captureVertexAttribPointer(
        location: number,
        size: number,
        type: number,
        normalized: boolean,
        stride: number,
        offset: number,
    ): void {
        if (!this.attributes.has(this.currentVao)) {
            this.attributes.set(this.currentVao, []);
        }

        const attrs = this.attributes.get(this.currentVao)!;
        // Upsert — replace existing attribute at same location
        const idx = attrs.findIndex((a) => a.location === location);
        const attr: VertexAttribute = {
            location,
            name: this.guessAttributeName(location),
            size,
            type,
            normalized,
            stride,
            offset,
            bufferId: this.boundArrayBuffer,
        };

        if (idx >= 0) {
            attrs[idx] = attr;
        } else {
            attrs.push(attr);
        }
    }

    /* ---- Getters ---- */

    getBuffer(id: number): CapturedBuffer | undefined {
        return this.buffers.get(id);
    }

    getAllBuffers(): CapturedBuffer[] {
        return Array.from(this.buffers.values());
    }

    getAttributes(vaoId: number): VertexAttribute[] {
        return this.attributes.get(vaoId) ?? [];
    }

    getAllAttributes(): Map<number, VertexAttribute[]> {
        return this.attributes;
    }

    /**
     * Get the index buffer bound to a specific VAO.
     */
    getIndexBufferForVao(vaoId: number): CapturedBuffer | undefined {
        const bufferId = this.indexBufferPerVao.get(vaoId);
        if (bufferId === undefined) return undefined;
        return this.buffers.get(bufferId);
    }

    /**
     * Get the last bound element array buffer (fallback for VAO-less rendering).
     */
    getActiveIndexBuffer(): CapturedBuffer | undefined {
        if (this.boundElementBuffer === 0) return undefined;
        return this.buffers.get(this.boundElementBuffer);
    }

    getBufferCount(): number {
        return this.buffers.size;
    }

    /**
     * Deduplicate buffers that share the same content.
     * Returns a map of old buffer ID → canonical buffer ID.
     */
    deduplicateBuffers(): Map<number, number> {
        const contentMap = new Map<string, number>(); // hash → canonical id
        const idMap = new Map<number, number>();       // old → canonical

        for (const [id, buf] of this.buffers) {
            // FNV-1a hash over full buffer content for reliable dedup
            const key = `${buf.byteLength}:${buf.target}:${BufferExtractor.fnv1a(new Uint8Array(buf.data))}`;

            const canonical = contentMap.get(key);
            if (canonical !== undefined) {
                // Verify content equality to guard against hash collisions
                const canonicalBuf = this.buffers.get(canonical);
                if (canonicalBuf && BufferExtractor.buffersEqual(buf.data, canonicalBuf.data)) {
                    idMap.set(id, canonical);
                } else {
                    // Hash collision: different content, keep as separate buffer
                    contentMap.set(key + ':' + id, id);
                    idMap.set(id, id);
                }
            } else {
                contentMap.set(key, id);
                idMap.set(id, id);
            }
        }

        return idMap;
    }

    /** FNV-1a 32-bit hash — fast, reliable, zero-dependency. */
    private static fnv1a(data: Uint8Array): number {
        let hash = 0x811c9dc5; // FNV offset basis
        for (let i = 0; i < data.length; i++) {
            hash ^= data[i];
            hash = (hash * 0x01000193) >>> 0; // FNV prime, keep as uint32
        }
        return hash;
    }

    /** Byte-level equality check for two ArrayBuffers. */
    private static buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
        if (a.byteLength !== b.byteLength) return false;
        const va = new Uint8Array(a);
        const vb = new Uint8Array(b);
        for (let i = 0; i < va.length; i++) {
            if (va[i] !== vb[i]) return false;
        }
        return true;
    }

    clear(): void {
        this.buffers.clear();
        this.attributes.clear();
        this.indexBufferPerVao.clear();
    }

    /* ---- Helpers ---- */

    /**
     * Best-effort guess at attribute semantics from layout location,
     * following the PBR vertex layout convention defined in rendering-pipeline.md.
     */
    private guessAttributeName(location: number): string {
        switch (location) {
            case 0: return 'POSITION';
            case 1: return 'NORMAL';
            case 2: return 'TANGENT';
            case 3: return 'TEXCOORD_0';
            case 4: return 'JOINTS_0';
            case 5: return 'WEIGHTS_0';
            case 6: return 'TEXCOORD_1';
            case 7: return 'COLOR_0';
            default: return `ATTR_${location}`;
        }
    }
}
