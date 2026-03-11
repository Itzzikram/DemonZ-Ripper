/**
 * SceneReconstructor — Post-capture analysis that rebuilds a logical
 * scene graph from intercepted WebGL draw calls.
 *
 * Groups draw calls by program → material, maps vertex attribute
 * pointers → mesh primitives, links textures to materials via sampler
 * uniform bindings, and deduplicates shared resources.
 */

import type {
    CapturedDrawCall,
    RipScene,
    RipNode,
    RipMesh,
    RipPrimitive,
    RipMaterial,
    RipTexture,
    RipMetadata,
    VertexAttribute,
} from '../types';
import type { BufferExtractor } from '../capture/buffer-extractor';
import type { TextureExtractor } from '../capture/texture-extractor';
import type { ShaderExtractor } from '../capture/shader-extractor';

export class SceneReconstructor {
    constructor(
        private bufferExtractor: BufferExtractor,
        private textureExtractor: TextureExtractor,
        private shaderExtractor: ShaderExtractor,
    ) { }

    reconstruct(drawCalls: CapturedDrawCall[], sourceUrl: string, captureTimeMs: number): RipScene {
        // Filter to main-pass draws: null (pre-IMP-10) or 0 (default framebuffer after IMP-10)
        const mainPassCalls = drawCalls.filter((dc) => dc.framebufferId === null || dc.framebufferId === 0);

        // Group draw calls by program → material
        const programGroups = this.groupByProgram(mainPassCalls);

        // Build materials
        const materials: RipMaterial[] = [];
        const meshes: RipMesh[] = [];
        const textures: RipTexture[] = [];
        const textureIdMap = new Map<number, number>(); // capturedTexId → export index
        const nodes: RipNode[] = [];

        let meshIndex = 0;

        for (const [programId, calls] of programGroups) {
            const program = this.shaderExtractor.getProgram(programId);
            if (!program) continue;

            // Parse attribute bindings from GLSL for accurate semantic names
            const attrBindings = this.shaderExtractor.parseAttributeBindings(
                program.vertexShader.source,
            );
            // Override guessed names in BufferExtractor with GLSL-parsed names
            for (const dc of calls) {
                const attrs = this.bufferExtractor.getAttributes(dc.vaoId);
                for (const attr of attrs) {
                    const parsed = attrBindings.get(attr.location);
                    if (parsed) attr.name = parsed;
                }
            }

            // Analyze shader for material properties
            const analysis = this.shaderExtractor.analyzeMaterialFromShader(programId);

            // Extract texture bindings for this material
            const matTextures = this.resolveTextureBindings(calls, textureIdMap, textures);

            // Infer alpha mode from draw call state and shader
            const hasBlend = calls.some((dc) => dc.blend);
            const hasDiscard = program.fragmentShader.source.includes('discard');
            const alphaMode = hasDiscard ? 'MASK' : hasBlend ? 'BLEND' : 'OPAQUE';

            const material: RipMaterial = {
                name: `Material_${materials.length}`,
                programId,
                baseColor: [1, 1, 1, 1],
                metallic: analysis.isPBR ? 0.5 : 0,
                roughness: analysis.isPBR ? 0.5 : 1,
                emissive: [0, 0, 0],
                albedoTextureIndex: matTextures.albedo,
                normalTextureIndex: matTextures.normal,
                metallicRoughnessTextureIndex: matTextures.metallicRoughness,
                emissiveTextureIndex: matTextures.emissive,
                doubleSided: false,
                alphaMode,
                alphaCutoff: hasDiscard ? 0.5 : 0.5,
                vertexShaderSource: program.vertexShader.source,
                fragmentShaderSource: program.fragmentShader.source,
            };
            const materialIndex = materials.length;
            materials.push(material);

            // Group calls by VAO → mesh
            const vaoGroups = this.groupByVAO(calls);

            for (const [vaoId, vaoCalls] of vaoGroups) {
                const primitives: RipPrimitive[] = [];

                for (const dc of vaoCalls) {
                    const prim = this.extractPrimitive(dc, vaoId, materialIndex);
                    if (prim) primitives.push(prim);
                }

                if (primitives.length > 0) {
                    meshes.push({
                        name: `Mesh_${meshIndex}`,
                        primitives,
                    });
                    nodes.push({
                        name: `Node_${meshIndex}`,
                        meshIndex,
                        children: [],
                        translation: [0, 0, 0],
                        rotation: [0, 0, 0, 1],
                        scale: [1, 1, 1],
                    });
                    meshIndex++;
                }
            }
        }

        const metadata: RipMetadata = {
            sourceUrl,
            capturedAt: new Date().toISOString(),
            totalDrawCalls: drawCalls.length,
            totalBuffers: this.bufferExtractor.getBufferCount(),
            totalTextures: this.textureExtractor.getTextureCount(),
            totalShaders: this.shaderExtractor.getShaderCount(),
            captureTimeMs,
            rendererInfo: '',
            canvasSize: [0, 0],
        };

        let sceneName: string;
        try {
            sceneName = `Ripped_${new URL(sourceUrl).hostname}`;
        } catch {
            sceneName = `Ripped_scene`;
        }

        return {
            name: sceneName,
            nodes,
            meshes,
            materials,
            textures,
            metadata,
        };
    }

    /* ---- Grouping helpers ---- */

    private groupByProgram(calls: CapturedDrawCall[]): Map<number, CapturedDrawCall[]> {
        const groups = new Map<number, CapturedDrawCall[]>();
        for (const dc of calls) {
            if (!groups.has(dc.programId)) groups.set(dc.programId, []);
            groups.get(dc.programId)!.push(dc);
        }
        return groups;
    }

    private groupByVAO(calls: CapturedDrawCall[]): Map<number, CapturedDrawCall[]> {
        const groups = new Map<number, CapturedDrawCall[]>();
        for (const dc of calls) {
            if (!groups.has(dc.vaoId)) groups.set(dc.vaoId, []);
            groups.get(dc.vaoId)!.push(dc);
        }
        return groups;
    }

    /* ---- Primitive extraction ---- */

    private extractPrimitive(
        dc: CapturedDrawCall,
        vaoId: number,
        materialIndex: number,
    ): RipPrimitive | null {
        const attrs = this.bufferExtractor.getAttributes(vaoId);
        if (attrs.length === 0) return null;

        const positions = this.extractAttribData(attrs, 'POSITION');
        if (!positions) return null; // must have positions at minimum

        // For indexed draws, dc.count is the index count, not vertex count.
        // Derive actual vertex count from the positions array.
        const vertexCount = positions.length / 3;

        return {
            positions,
            normals: this.extractAttribData(attrs, 'NORMAL'),
            tangents: this.extractAttribData(attrs, 'TANGENT'),
            uvs: this.extractAttribData(attrs, 'TEXCOORD_0'),
            uvs2: this.extractAttribData(attrs, 'TEXCOORD_1'),
            colors: this.extractAttribData(attrs, 'COLOR_0'),
            jointIndices: this.extractAttribDataUint16(attrs, 'JOINTS_0'),
            jointWeights: this.extractAttribData(attrs, 'WEIGHTS_0'),
            indices: dc.indexed ? this.extractIndices(dc, vaoId) : null,
            materialIndex,
            mode: dc.mode,
            vertexCount,
        };
    }

    /**
     * Extract vertex attribute data, properly handling interleaved (strided) buffers.
     * Copies strided data into a compact Float32Array.
     */
    private extractAttribData(attrs: VertexAttribute[], name: string): Float32Array | null {
        const attr = attrs.find((a) => a.name === name);
        if (!attr) return null;

        // Vertex attributes must have 1–4 components; 0 causes division by zero
        if (attr.size <= 0 || attr.size > 4) return null;

        const buffer = this.bufferExtractor.getBuffer(attr.bufferId);
        if (!buffer) return null;

        if (!buffer.data || buffer.data.byteLength === 0) return null;

        const bytesPerComponent = 4; // FLOAT
        const bytesPerVertex = attr.size * bytesPerComponent;
        // stride=0 in WebGL means tightly packed
        const stride = attr.stride === 0 ? bytesPerVertex : (attr.stride || bytesPerVertex);

        // Calculate vertex count from available data after offset
        const availableBytes = buffer.data.byteLength - attr.offset;
        if (availableBytes < bytesPerVertex) return null;
        const vertexCount = 1 + Math.floor((availableBytes - bytesPerVertex) / stride);
        if (vertexCount <= 0) return null;

        // If tightly packed (stride === element size) AND offset is 4-byte aligned, fast path
        if (stride === bytesPerVertex && (attr.offset % 4 === 0)) {
            // Bounds check: ensure we don't read past buffer end
            const neededBytes = attr.offset + vertexCount * bytesPerVertex;
            if (neededBytes > buffer.data.byteLength) return null;
            return new Float32Array(buffer.data, attr.offset, vertexCount * attr.size);
        }

        // De-interleave: copy strided data into a compact array
        const out = new Float32Array(vertexCount * attr.size);
        const src = new DataView(buffer.data);
        for (let i = 0; i < vertexCount; i++) {
            const baseOffset = attr.offset + i * stride;
            // Bounds check each vertex read
            if (baseOffset + bytesPerVertex > buffer.data.byteLength) break;
            for (let c = 0; c < attr.size; c++) {
                out[i * attr.size + c] = src.getFloat32(
                    baseOffset + c * bytesPerComponent, true
                );
            }
        }
        return out;
    }

    /**
     * Extract Uint16 attribute data with stride handling.
     */
    private extractAttribDataUint16(attrs: VertexAttribute[], name: string): Uint16Array | null {
        const attr = attrs.find((a) => a.name === name);
        if (!attr) return null;

        const buffer = this.bufferExtractor.getBuffer(attr.bufferId);
        if (!buffer) return null;

        if (!buffer.data || buffer.data.byteLength === 0) return null;

        const bytesPerComponent = 2; // UNSIGNED_SHORT
        const bytesPerVertex = attr.size * bytesPerComponent;
        // stride=0 in WebGL means tightly packed
        const stride = attr.stride === 0 ? bytesPerVertex : (attr.stride || bytesPerVertex);

        const availableBytes = buffer.data.byteLength - attr.offset;
        if (availableBytes < bytesPerVertex) return null;
        const vertexCount = 1 + Math.floor((availableBytes - bytesPerVertex) / stride);
        if (vertexCount <= 0) return null;

        if (stride === bytesPerVertex && (attr.offset % 2 === 0)) {
            const neededBytes = attr.offset + vertexCount * bytesPerVertex;
            if (neededBytes > buffer.data.byteLength) return null;
            return new Uint16Array(buffer.data, attr.offset, vertexCount * attr.size);
        }

        const out = new Uint16Array(vertexCount * attr.size);
        const src = new DataView(buffer.data);
        for (let i = 0; i < vertexCount; i++) {
            const baseOffset = attr.offset + i * stride;
            if (baseOffset + bytesPerVertex > buffer.data.byteLength) break;
            for (let c = 0; c < attr.size; c++) {
                out[i * attr.size + c] = src.getUint16(
                    baseOffset + c * bytesPerComponent, true
                );
            }
        }
        return out;
    }

    /**
     * Extract index data using the per-VAO index buffer binding.
     * Falls back to first ELEMENT_ARRAY_BUFFER if VAO binding not found.
     */
    private extractIndices(dc: CapturedDrawCall, vaoId: number): Uint16Array | Uint32Array | null {
        // Try per-VAO index buffer first (correct behavior)
        let indexBuffer = this.bufferExtractor.getIndexBufferForVao(vaoId);

        // Fallback: try the active element buffer
        if (!indexBuffer) {
            indexBuffer = this.bufferExtractor.getActiveIndexBuffer();
        }

        // Last resort: find any ELEMENT_ARRAY_BUFFER (legacy path)
        if (!indexBuffer) {
            const allBuffers = this.bufferExtractor.getAllBuffers();
            indexBuffer = allBuffers.find(
                (b) => b.target === 0x8893 /* ELEMENT_ARRAY_BUFFER */,
            );
        }

        if (!indexBuffer || !indexBuffer.data || indexBuffer.data.byteLength === 0) return null;

        // Use DataView to safely handle arbitrary byte offsets (avoids RangeError
        // on unaligned offsets that Uint16Array/Uint32Array constructors would throw)
        const dv = new DataView(indexBuffer.data);

        if (dc.indexType === 0x1401 /* UNSIGNED_BYTE */) {
            const endByte = dc.offset + dc.count;
            if (endByte > indexBuffer.data.byteLength) return null; // bounds check
            const out = new Uint16Array(dc.count); // promote to Uint16 for glTF compat
            for (let i = 0; i < dc.count; i++) {
                out[i] = dv.getUint8(dc.offset + i);
            }
            return out;
        }
        if (dc.indexType === 0x1403 /* UNSIGNED_SHORT */) {
            const endByte = dc.offset + dc.count * 2;
            if (endByte > indexBuffer.data.byteLength) return null; // bounds check
            const out = new Uint16Array(dc.count);
            for (let i = 0; i < dc.count; i++) {
                out[i] = dv.getUint16(dc.offset + i * 2, true);
            }
            return out;
        }
        if (dc.indexType === 0x1405 /* UNSIGNED_INT */) {
            const endByte = dc.offset + dc.count * 4;
            if (endByte > indexBuffer.data.byteLength) return null; // bounds check
            const out = new Uint32Array(dc.count);
            for (let i = 0; i < dc.count; i++) {
                out[i] = dv.getUint32(dc.offset + i * 4, true);
            }
            return out;
        }
        return null;
    }

    /* ---- Texture resolution ---- */

    /**
     * Resolve texture roles using sampler uniform names from the shader,
     * falling back to texture-unit order if names are unavailable.
     */
    private resolveTextureBindings(
        calls: CapturedDrawCall[],
        textureIdMap: Map<number, number>,
        textures: RipTexture[],
    ): {
        albedo: number | null;
        normal: number | null;
        metallicRoughness: number | null;
        emissive: number | null;
    } {
        const result = { albedo: null as number | null, normal: null as number | null, metallicRoughness: null as number | null, emissive: null as number | null };

        // Collect unique texture bindings with their sampler names
        const bindingInfo: { texId: number; samplerName: string; unit: number }[] = [];
        const seenTexIds = new Set<number>();

        for (const dc of calls) {
            for (const binding of dc.textureBindings) {
                if (seenTexIds.has(binding.textureId)) continue;
                seenTexIds.add(binding.textureId);
                bindingInfo.push({
                    texId: binding.textureId,
                    samplerName: binding.samplerUniform ?? '',
                    unit: binding.unit,
                });
            }
        }

        // Add each unique texture to the export list and resolve roles
        for (const info of bindingInfo) {
            const captured = this.textureExtractor.getTexture(info.texId);
            if (!captured) continue;

            let exportIndex = textureIdMap.get(info.texId);
            if (exportIndex === undefined) {
                exportIndex = textures.length;
                textureIdMap.set(info.texId, exportIndex);
                textures.push({
                    name: `Texture_${exportIndex}`,
                    width: captured.width,
                    height: captured.height,
                    data: captured.data ?? new ArrayBuffer(0),
                    format: captured.format,
                    compressed: captured.compressed,
                    mimeType: captured.compressed ? 'application/octet-stream' : 'image/png',
                });
            }

            // Try to assign role from sampler uniform name
            const role = this.inferTextureRole(info.samplerName, captured.label ?? '');
            if (role === 'albedo' && result.albedo === null) result.albedo = exportIndex;
            else if (role === 'normal' && result.normal === null) result.normal = exportIndex;
            else if (role === 'metallicRoughness' && result.metallicRoughness === null) result.metallicRoughness = exportIndex;
            else if (role === 'emissive' && result.emissive === null) result.emissive = exportIndex;
        }

        // Fallback: assign unresolved textures by slot order
        let fallbackSlot = 0;
        for (const info of bindingInfo) {
            const exportIndex = textureIdMap.get(info.texId);
            if (exportIndex === undefined) continue;
            if (fallbackSlot === 0 && result.albedo === null) { result.albedo = exportIndex; fallbackSlot++; }
            else if (fallbackSlot === 1 && result.normal === null) { result.normal = exportIndex; fallbackSlot++; }
            else if (fallbackSlot === 2 && result.metallicRoughness === null) { result.metallicRoughness = exportIndex; fallbackSlot++; }
            else if (fallbackSlot === 3 && result.emissive === null) { result.emissive = exportIndex; fallbackSlot++; }
        }

        return result;
    }

    /** Infer a PBR texture role from uniform name or texture label. */
    private inferTextureRole(uniformName: string, label: string): 'albedo' | 'normal' | 'metallicRoughness' | 'emissive' | 'unknown' {
        const name = (uniformName + ' ' + label).toLowerCase();

        // Albedo / diffuse / base color
        if (/albedo|diffuse|base.?color|color.?map|s_?color/.test(name)) return 'albedo';
        // Normal map
        if (/normal|bump|nrm/.test(name)) return 'normal';
        // Metallic-roughness / ORM / specular
        if (/metallic|roughness|orm|specular|glossiness|mr.?map/.test(name)) return 'metallicRoughness';
        // Emissive
        if (/emissive|emission|glow/.test(name)) return 'emissive';

        return 'unknown';
    }


}
