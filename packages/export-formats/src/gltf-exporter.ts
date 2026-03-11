/**
 * GLTFExporter — Converts a RipScene to glTF 2.0 JSON + binary (or single .glb).
 *
 * Maps captured vertex layouts to glTF accessors/bufferViews,
 * textures to glTF images/samplers, and shader-derived materials
 * to PBR metallic-roughness materials.
 */

import type {
    RipScene,
    RipMesh,
    RipPrimitive,
    RipMaterial,
    RipTexture,
} from '@platform/webgl-ripper';

/* ---- glTF JSON types (subset) ---- */

interface GLTFRoot {
    asset: { version: string; generator: string };
    scene: number;
    scenes: { name: string; nodes: number[] }[];
    nodes: { name: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
    meshes: { name: string; primitives: GLTFPrimitiveJSON[] }[];
    accessors: GLTFAccessor[];
    bufferViews: GLTFBufferView[];
    buffers: { byteLength: number; uri?: string }[];
    materials: GLTFMaterialJSON[];
    textures?: { source: number; sampler?: number }[];
    images?: { uri?: string; bufferView?: number; mimeType?: string }[];
    samplers?: { magFilter: number; minFilter: number; wrapS: number; wrapT: number }[];
}

interface GLTFPrimitiveJSON {
    attributes: Record<string, number>;
    indices?: number;
    material?: number;
    mode?: number;
}

interface GLTFAccessor {
    bufferView: number;
    byteOffset: number;
    componentType: number;
    count: number;
    type: string;
    max?: number[];
    min?: number[];
}

interface GLTFBufferView {
    buffer: number;
    byteOffset: number;
    byteLength: number;
    target?: number;
    byteStride?: number;
}

interface GLTFMaterialJSON {
    name: string;
    pbrMetallicRoughness: {
        baseColorFactor?: number[];
        metallicFactor?: number;
        roughnessFactor?: number;
        baseColorTexture?: { index: number };
        metallicRoughnessTexture?: { index: number };
    };
    normalTexture?: { index: number };
    emissiveFactor?: number[];
    emissiveTexture?: { index: number };
    doubleSided?: boolean;
    alphaMode?: string;
    alphaCutoff?: number;
}

/* ---- Export result ---- */

export interface GLTFExportResult {
    json: GLTFRoot;
    binary: ArrayBuffer;
    glb: ArrayBuffer | null;
}

/* ---- Exporter ---- */

export class GLTFExporter {
    private binaryChunks: ArrayBuffer[] = [];
    private currentByteOffset = 0;

    export(scene: RipScene, options?: { embedBinary?: boolean }): GLTFExportResult {
        this.binaryChunks = [];
        this.currentByteOffset = 0;

        const gltf: GLTFRoot = {
            asset: { version: '2.0', generator: 'DemonZ Ripper GLTFExporter' },
            scene: 0,
            scenes: [{ name: scene.name, nodes: scene.nodes.map((_: unknown, i: number) => i) }],
            nodes: [],
            meshes: [],
            accessors: [],
            bufferViews: [],
            buffers: [],
            materials: [],
        };

        // Materials
        for (const mat of scene.materials) {
            gltf.materials.push(this.buildMaterial(mat, scene.textures, gltf));
        }

        // Meshes + nodes
        for (let i = 0; i < scene.meshes.length; i++) {
            const mesh = scene.meshes[i];
            const gltfPrims: GLTFPrimitiveJSON[] = [];

            for (const prim of mesh.primitives) {
                gltfPrims.push(this.buildPrimitive(prim, gltf));
            }

            gltf.meshes.push({ name: mesh.name, primitives: gltfPrims });
        }

        for (const node of scene.nodes) {
            gltf.nodes.push({
                name: node.name,
                mesh: node.meshIndex !== null ? node.meshIndex : undefined,
                children: node.children.length > 0 ? node.children : undefined,
                translation: node.translation,
                rotation: node.rotation,
                scale: node.scale,
            });
        }

        // Finalize buffer
        const totalBinary = this.concatBuffers(this.binaryChunks);
        gltf.buffers = [{ byteLength: totalBinary.byteLength }];

        const embedBinary = options?.embedBinary ?? true;
        let glb: ArrayBuffer | null = null;

        if (embedBinary) {
            glb = this.buildGLB(gltf, totalBinary);
        } else {
            gltf.buffers[0].uri = 'scene.bin';
        }

        return { json: gltf, binary: totalBinary, glb };
    }

    /* ---- Primitive building ---- */

    private buildPrimitive(prim: RipPrimitive, gltf: GLTFRoot): GLTFPrimitiveJSON {
        const result: GLTFPrimitiveJSON = { attributes: {}, mode: prim.mode };

        // Positions (required) — compute min/max for bounding box
        result.attributes['POSITION'] = this.addAccessor(
            gltf, prim.positions, 'VEC3', 5126 /* FLOAT */, 34962 /* ARRAY_BUFFER */, true,
        );

        // Optional attributes
        if (prim.normals) {
            result.attributes['NORMAL'] = this.addAccessor(
                gltf, prim.normals, 'VEC3', 5126, 34962,
            );
        }
        if (prim.tangents) {
            result.attributes['TANGENT'] = this.addAccessor(
                gltf, prim.tangents, 'VEC4', 5126, 34962,
            );
        }
        if (prim.uvs) {
            result.attributes['TEXCOORD_0'] = this.addAccessor(
                gltf, prim.uvs, 'VEC2', 5126, 34962,
            );
        }
        if (prim.uvs2) {
            result.attributes['TEXCOORD_1'] = this.addAccessor(
                gltf, prim.uvs2, 'VEC2', 5126, 34962,
            );
        }
        if (prim.colors) {
            result.attributes['COLOR_0'] = this.addAccessor(
                gltf, prim.colors, 'VEC4', 5126, 34962,
            );
        }
        if (prim.jointIndices) {
            result.attributes['JOINTS_0'] = this.addAccessor(
                gltf, prim.jointIndices, 'VEC4', 5123 /* UNSIGNED_SHORT */, 34962,
            );
        }
        if (prim.jointWeights) {
            result.attributes['WEIGHTS_0'] = this.addAccessor(
                gltf, prim.jointWeights, 'VEC4', 5126, 34962,
            );
        }

        // Indices
        if (prim.indices) {
            const componentType = prim.indices instanceof Uint16Array ? 5123 : 5125;
            result.indices = this.addAccessor(
                gltf, prim.indices, 'SCALAR', componentType, 34963 /* ELEMENT_ARRAY_BUFFER */,
            );
        }

        result.material = prim.materialIndex;
        return result;
    }

    private addAccessor(
        gltf: GLTFRoot,
        data: Float32Array | Uint16Array | Uint32Array,
        type: string,
        componentType: number,
        target: number,
        computeMinMax = false,
    ): number {
        const byteOffset = this.currentByteOffset;
        const byteLength = data.byteLength;

        // Align to 4 bytes
        const padding = (4 - (byteLength % 4)) % 4;
        const paddedBuffer = new ArrayBuffer(byteLength + padding);
        new Uint8Array(paddedBuffer).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        this.binaryChunks.push(paddedBuffer);
        this.currentByteOffset += paddedBuffer.byteLength;

        const bufferViewIndex = gltf.bufferViews.length;
        gltf.bufferViews.push({
            buffer: 0,
            byteOffset,
            byteLength,
            target,
        });

        const componentsPerElement = this.typeToComponents(type);
        const bytesPerComponent = this.componentTypeToBytes(componentType);
        const elementSize = componentsPerElement * bytesPerComponent;
        if (elementSize === 0) {
            throw new Error(`Invalid accessor: type=${type}, componentType=${componentType}`);
        }
        const count = Math.floor(byteLength / elementSize);
        if (count <= 0) {
            throw new Error(`Accessor has zero elements: byteLength=${byteLength}, elementSize=${elementSize}`);
        }

        const accessor: GLTFAccessor = {
            bufferView: bufferViewIndex,
            byteOffset: 0,
            componentType,
            count,
            type,
        };

        // Compute min/max (required for POSITION, useful for validation)
        if (computeMinMax && data instanceof Float32Array && componentsPerElement > 0) {
            const min = new Array(componentsPerElement).fill(Infinity);
            const max = new Array(componentsPerElement).fill(-Infinity);

            for (let i = 0; i < count; i++) {
                for (let c = 0; c < componentsPerElement; c++) {
                    const val = data[i * componentsPerElement + c];
                    if (val < min[c]) min[c] = val;
                    if (val > max[c]) max[c] = val;
                }
            }

            // Ensure finite values
            const isFinite = (v: number) => Number.isFinite(v);
            if (min.every(isFinite) && max.every(isFinite)) {
                accessor.min = min;
                accessor.max = max;
            }
        }

        const accessorIndex = gltf.accessors.length;
        gltf.accessors.push(accessor);

        return accessorIndex;
    }

    /* ---- Material building ---- */

    private getValidTextureIndex(idx: number | null, textures: RipTexture[]): number | null {
        if (idx === null || idx < 0 || idx >= textures.length) return null;
        const tex = textures[idx];
        if (!tex || !tex.data || tex.data.byteLength === 0) return null;
        return idx;
    }

    private buildMaterial(
        mat: RipMaterial,
        textures: RipTexture[],
        gltf: GLTFRoot,
    ): GLTFMaterialJSON {
        // Ensure texture arrays exist
        if (!gltf.textures) gltf.textures = [];
        if (!gltf.images) gltf.images = [];
        if (!gltf.samplers) {
            gltf.samplers = [{
                magFilter: 9729, /* LINEAR */
                minFilter: 9987, /* LINEAR_MIPMAP_LINEAR */
                wrapS: 10497,    /* REPEAT */
                wrapT: 10497,
            }];
        }

        const result: GLTFMaterialJSON = {
            name: mat.name,
            pbrMetallicRoughness: {
                baseColorFactor: [...mat.baseColor],
                metallicFactor: mat.metallic,
                roughnessFactor: mat.roughness,
            },
            doubleSided: mat.doubleSided,
            alphaMode: mat.alphaMode,
        };

        if (mat.alphaMode === 'MASK' && mat.alphaCutoff !== 0.5) {
            result.alphaCutoff = mat.alphaCutoff;
        }

        // Texture references (addTextureToGLTF returns -1 if data is missing)
        const albedoIdx = this.getValidTextureIndex(mat.albedoTextureIndex, textures);
        if (albedoIdx !== null) {
            const texIdx = this.addTextureToGLTF(gltf, textures[albedoIdx]);
            if (texIdx >= 0) result.pbrMetallicRoughness.baseColorTexture = { index: texIdx };
        }
        const mrIdx = this.getValidTextureIndex(mat.metallicRoughnessTextureIndex, textures);
        if (mrIdx !== null) {
            const texIdx = this.addTextureToGLTF(gltf, textures[mrIdx]);
            if (texIdx >= 0) result.pbrMetallicRoughness.metallicRoughnessTexture = { index: texIdx };
        }
        const normalIdx = this.getValidTextureIndex(mat.normalTextureIndex, textures);
        if (normalIdx !== null) {
            const texIdx = this.addTextureToGLTF(gltf, textures[normalIdx]);
            if (texIdx >= 0) result.normalTexture = { index: texIdx };
        }
        const emissiveIdx = this.getValidTextureIndex(mat.emissiveTextureIndex, textures);
        if (emissiveIdx !== null) {
            const texIdx = this.addTextureToGLTF(gltf, textures[emissiveIdx]);
            if (texIdx >= 0) result.emissiveTexture = { index: texIdx };
        }

        // Emit emissive factor if any channel is non-zero (with or without texture)
        if (mat.emissive[0] > 0 || mat.emissive[1] > 0 || mat.emissive[2] > 0) {
            result.emissiveFactor = [...mat.emissive];
        }

        return result;
    }

    private addTextureToGLTF(gltf: GLTFRoot, ripTex: RipTexture): number {
        // Skip textures with no data (CORS blocked or readback failed)
        if (!ripTex.data || ripTex.data.byteLength === 0) return -1;

        const imageByteOffset = this.currentByteOffset;
        const imageData = ripTex.data;
        const padding = (4 - (imageData.byteLength % 4)) % 4;
        const paddedBuffer = new ArrayBuffer(imageData.byteLength + padding);
        new Uint8Array(paddedBuffer).set(new Uint8Array(imageData));
        this.binaryChunks.push(paddedBuffer);
        this.currentByteOffset += paddedBuffer.byteLength;

        const imageBufferViewIndex = gltf.bufferViews.length;
        gltf.bufferViews.push({
            buffer: 0,
            byteOffset: imageByteOffset,
            byteLength: imageData.byteLength,
        });

        const imageIndex = gltf.images!.length;
        gltf.images!.push({
            bufferView: imageBufferViewIndex,
            mimeType: ripTex.mimeType,
        });

        const texIndex = gltf.textures!.length;
        gltf.textures!.push({
            source: imageIndex,
            sampler: 0,
        });

        return texIndex;
    }

    /* ---- GLB packing ---- */

    private buildGLB(gltf: GLTFRoot, binary: ArrayBuffer): ArrayBuffer {
        const jsonStr = JSON.stringify(gltf);
        const jsonBytes = new TextEncoder().encode(jsonStr);

        // Pad JSON to 4-byte alignment
        const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
        const jsonChunkLength = jsonBytes.byteLength + jsonPadding;

        // Pad binary to 4-byte alignment
        const binPadding = (4 - (binary.byteLength % 4)) % 4;
        const binChunkLength = binary.byteLength + binPadding;

        // GLB header (12) + JSON chunk header (8) + JSON + optional BIN chunk
        const hasBin = binary.byteLength > 0;
        const totalLength = 12 + 8 + jsonChunkLength + (hasBin ? (8 + binChunkLength) : 0);
        const glb = new ArrayBuffer(totalLength);
        const view = new DataView(glb);
        const bytes = new Uint8Array(glb);

        // GLB header
        view.setUint32(0, 0x46546C67, true); // magic: "glTF"
        view.setUint32(4, 2, true);           // version: 2
        view.setUint32(8, totalLength, true);  // total length

        // JSON chunk
        view.setUint32(12, jsonChunkLength, true);       // chunk length
        view.setUint32(16, 0x4E4F534A, true);            // chunk type: "JSON"
        bytes.set(jsonBytes, 20);
        // Pad with spaces (0x20)
        for (let i = 0; i < jsonPadding; i++) bytes[20 + jsonBytes.byteLength + i] = 0x20;

        // BIN chunk (only if there's binary data)
        if (hasBin) {
            const binOffset = 20 + jsonChunkLength;
            view.setUint32(binOffset, binChunkLength, true);  // chunk length
            view.setUint32(binOffset + 4, 0x004E4942, true);  // chunk type: "BIN\0"
            bytes.set(new Uint8Array(binary), binOffset + 8);
            // Pad with zeros
            for (let i = 0; i < binPadding; i++) bytes[binOffset + 8 + binary.byteLength + i] = 0;
        }

        return glb;
    }

    /* ---- Helpers ---- */

    private concatBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
        let totalLength = 0;
        for (const b of buffers) totalLength += b.byteLength;

        const result = new ArrayBuffer(totalLength);
        const view = new Uint8Array(result);
        let offset = 0;
        for (const b of buffers) {
            view.set(new Uint8Array(b), offset);
            offset += b.byteLength;
        }
        return result;
    }

    private typeToComponents(type: string): number {
        switch (type) {
            case 'SCALAR': return 1;
            case 'VEC2': return 2;
            case 'VEC3': return 3;
            case 'VEC4': return 4;
            case 'MAT2': return 4;
            case 'MAT3': return 9;
            case 'MAT4': return 16;
            default: return 1;
        }
    }

    private componentTypeToBytes(componentType: number): number {
        switch (componentType) {
            case 5120: return 1;  // BYTE
            case 5121: return 1;  // UNSIGNED_BYTE
            case 5122: return 2;  // SHORT
            case 5123: return 2;  // UNSIGNED_SHORT
            case 5125: return 4;  // UNSIGNED_INT
            case 5126: return 4;  // FLOAT
            default: return 4;
        }
    }
}
