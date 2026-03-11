/**
 * Unit tests for BufferExtractor.
 *
 * Tests per-VAO index buffer tracking, buffer capture,
 * sub-data merging, and deduplication.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BufferExtractor } from './buffer-extractor';

describe('BufferExtractor', () => {
    let extractor: BufferExtractor;

    beforeEach(() => {
        extractor = new BufferExtractor();
    });

    it('captures buffer data', () => {
        const data = new Float32Array([1.0, 2.0, 3.0]).buffer;
        extractor.captureBufferData(1, 0x8892 /* ARRAY_BUFFER */, data, 0x88E4);

        const buf = extractor.getBuffer(1);
        expect(buf).toBeDefined();
        expect(buf!.id).toBe(1);
        expect(buf!.byteLength).toBe(12);
        expect(buf!.target).toBe(0x8892);
    });

    it('captures sub-data and merges into existing buffer', () => {
        const data = new Uint8Array([0, 0, 0, 0]).buffer;
        extractor.captureBufferData(1, 0x8892, data, 0x88E4);

        const subData = new Uint8Array([42, 43]).buffer;
        extractor.captureBufferSubData(1, 0x8892, 1, subData);

        const buf = extractor.getBuffer(1);
        const view = new Uint8Array(buf!.data);
        expect(view[0]).toBe(0);
        expect(view[1]).toBe(42);
        expect(view[2]).toBe(43);
        expect(view[3]).toBe(0);
    });

    it('tracks index buffer per VAO', () => {
        // Create buffers
        extractor.captureBufferData(10, 0x8893 /* ELEMENT_ARRAY_BUFFER */, new Uint16Array([0, 1, 2]).buffer, 0x88E4);
        extractor.captureBufferData(20, 0x8893, new Uint16Array([3, 4, 5]).buffer, 0x88E4);

        // Bind VAO 1 with index buffer 10
        extractor.onBindVertexArray(1);
        extractor.onBindBuffer(0x8893, 10);

        // Bind VAO 2 with index buffer 20
        extractor.onBindVertexArray(2);
        extractor.onBindBuffer(0x8893, 20);

        // Verify per-VAO resolution
        const vao1Index = extractor.getIndexBufferForVao(1);
        expect(vao1Index).toBeDefined();
        expect(vao1Index!.id).toBe(10);

        const vao2Index = extractor.getIndexBufferForVao(2);
        expect(vao2Index).toBeDefined();
        expect(vao2Index!.id).toBe(20);

        // Non-existent VAO
        expect(extractor.getIndexBufferForVao(99)).toBeUndefined();
    });

    it('captures vertex attribute pointers for the current VAO', () => {
        extractor.onBindVertexArray(1);
        extractor.onBindBuffer(0x8892, 5); // ARRAY_BUFFER
        extractor.captureVertexAttribPointer(0, 3, 5126, false, 12, 0);
        extractor.captureVertexAttribPointer(1, 3, 5126, false, 12, 0);

        const attrs = extractor.getAttributes(1);
        expect(attrs).toHaveLength(2);
        expect(attrs[0].name).toBe('POSITION');
        expect(attrs[1].name).toBe('NORMAL');
    });

    it('deduplicates buffers with identical content', () => {
        const data1 = new Uint8Array([1, 2, 3, 4]).buffer;
        const data2 = new Uint8Array([1, 2, 3, 4]).buffer; // same content
        const data3 = new Uint8Array([5, 6, 7, 8]).buffer; // different

        extractor.captureBufferData(1, 0x8892, data1, 0x88E4);
        extractor.captureBufferData(2, 0x8892, data2, 0x88E4);
        extractor.captureBufferData(3, 0x8892, data3, 0x88E4);

        const idMap = extractor.deduplicateBuffers();
        expect(idMap.get(1)).toBe(1); // canonical
        expect(idMap.get(2)).toBe(1); // deduped to 1
        expect(idMap.get(3)).toBe(3); // unique
    });

    it('reports correct buffer count', () => {
        extractor.captureBufferData(1, 0x8892, new Float32Array([1]).buffer, 0x88E4);
        extractor.captureBufferData(2, 0x8893, new Uint16Array([0]).buffer, 0x88E4);
        expect(extractor.getBufferCount()).toBe(2);
    });

    it('clears all data', () => {
        extractor.captureBufferData(1, 0x8892, new Float32Array([1]).buffer, 0x88E4);
        extractor.clear();
        expect(extractor.getBufferCount()).toBe(0);
        expect(extractor.getAllBuffers()).toHaveLength(0);
    });
});
