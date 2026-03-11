/**
 * Unit tests for GLTFExporter.
 *
 * Tests glTF JSON structure, accessor min/max computation,
 * GLB binary packing, and material export.
 */

import { describe, it, expect } from 'vitest';
import { GLTFExporter } from './gltf-exporter';
import type { RipScene, RipNode, RipMesh, RipPrimitive, RipMaterial, RipTexture, RipMetadata } from '@platform/webgl-ripper';

function createTestScene(): RipScene {
    const positions = new Float32Array([
        -1, -1, 0,
        1, -1, 0,
        0, 1, 0,
    ]);

    const indices = new Uint16Array([0, 1, 2]);

    const primitive: RipPrimitive = {
        positions,
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        tangents: null,
        uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
        uvs2: null,
        colors: null,
        jointIndices: null,
        jointWeights: null,
        indices,
        materialIndex: 0,
        mode: 4, // TRIANGLES
        vertexCount: 3,
    };

    const mesh: RipMesh = {
        name: 'TestMesh',
        primitives: [primitive],
    };

    const material: RipMaterial = {
        name: 'TestMaterial',
        programId: 1,
        baseColor: [0.8, 0.2, 0.2, 1.0],
        metallic: 0.5,
        roughness: 0.5,
        emissive: [0, 0, 0],
        albedoTextureIndex: null,
        normalTextureIndex: null,
        metallicRoughnessTextureIndex: null,
        emissiveTextureIndex: null,
        doubleSided: false,
        alphaMode: 'OPAQUE',
        alphaCutoff: 0.5,
        vertexShaderSource: '',
        fragmentShaderSource: '',
    };

    const node: RipNode = {
        name: 'TestNode',
        meshIndex: 0,
        children: [],
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
    };

    const metadata: RipMetadata = {
        sourceUrl: 'https://example.com',
        capturedAt: new Date().toISOString(),
        totalDrawCalls: 1,
        totalBuffers: 2,
        totalTextures: 0,
        totalShaders: 2,
        captureTimeMs: 100,
        rendererInfo: 'test',
        canvasSize: [1920, 1080],
    };

    return {
        name: 'TestScene',
        nodes: [node],
        meshes: [mesh],
        materials: [material],
        textures: [],
        metadata,
    };
}

describe('GLTFExporter', () => {
    it('exports valid glTF JSON structure', () => {
        const exporter = new GLTFExporter();
        const scene = createTestScene();
        const result = exporter.export(scene, { embedBinary: false });

        expect(result.json.asset.version).toBe('2.0');
        expect(result.json.scene).toBe(0);
        expect(result.json.scenes).toHaveLength(1);
        expect(result.json.nodes).toHaveLength(1);
        expect(result.json.meshes).toHaveLength(1);
        expect(result.json.materials).toHaveLength(1);
    });

    it('computes min/max for position accessors', () => {
        const exporter = new GLTFExporter();
        const scene = createTestScene();
        const result = exporter.export(scene, { embedBinary: false });

        // Find the position accessor (first one, since POSITION is first)
        const posAccessor = result.json.accessors[0];
        expect(posAccessor.min).toBeDefined();
        expect(posAccessor.max).toBeDefined();
        expect(posAccessor.min).toEqual([-1, -1, 0]);
        expect(posAccessor.max).toEqual([1, 1, 0]);
        expect(posAccessor.type).toBe('VEC3');
        expect(posAccessor.componentType).toBe(5126); // FLOAT
    });

    it('exports indices as SCALAR accessors', () => {
        const exporter = new GLTFExporter();
        const scene = createTestScene();
        const result = exporter.export(scene, { embedBinary: false });

        // Find the index accessor (the one that is SCALAR)
        const idxAccessor = result.json.accessors.find((a) => a.type === 'SCALAR');
        expect(idxAccessor).toBeDefined();
        expect(idxAccessor!.componentType).toBe(5123); // UNSIGNED_SHORT
        expect(idxAccessor!.count).toBe(3);
    });

    it('builds valid GLB binary', () => {
        const exporter = new GLTFExporter();
        const scene = createTestScene();
        const result = exporter.export(scene, { embedBinary: true });

        expect(result.glb).not.toBeNull();
        const view = new DataView(result.glb!);

        // Check GLB header
        expect(view.getUint32(0, true)).toBe(0x46546C67); // "glTF" magic
        expect(view.getUint32(4, true)).toBe(2);           // version 2
        expect(view.getUint32(8, true)).toBe(result.glb!.byteLength); // total length
    });

    it('GLB binary is 4-byte aligned', () => {
        const exporter = new GLTFExporter();
        const scene = createTestScene();
        const result = exporter.export(scene, { embedBinary: true });

        expect(result.glb!.byteLength % 4).toBe(0);
    });

    it('exports material with PBR properties', () => {
        const exporter = new GLTFExporter();
        const scene = createTestScene();
        const result = exporter.export(scene);

        const mat = result.json.materials[0];
        expect(mat.name).toBe('TestMaterial');
        expect(mat.pbrMetallicRoughness.baseColorFactor).toEqual([0.8, 0.2, 0.2, 1.0]);
        expect(mat.pbrMetallicRoughness.metallicFactor).toBe(0.5);
        expect(mat.pbrMetallicRoughness.roughnessFactor).toBe(0.5);
    });

    it('produces valid binary data matching buffer length', () => {
        const exporter = new GLTFExporter();
        const scene = createTestScene();
        const result = exporter.export(scene, { embedBinary: false });

        expect(result.binary.byteLength).toBe(result.json.buffers[0].byteLength);
    });
});
