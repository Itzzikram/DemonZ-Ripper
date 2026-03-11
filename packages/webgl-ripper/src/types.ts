/**
 * Core type definitions for the WebGL ripping system.
 */

/* ------------------------------------------------------------------ */
/*  Captured GPU Data                                                 */
/* ------------------------------------------------------------------ */

export interface CapturedBuffer {
    id: number;
    target: number; // ARRAY_BUFFER | ELEMENT_ARRAY_BUFFER
    data: ArrayBuffer;
    usage: number;
    byteLength: number;
}

export interface VertexAttribute {
    location: number;
    name: string;
    size: number;       // 1-4 components
    type: number;       // gl.FLOAT, gl.UNSIGNED_SHORT, etc.
    normalized: boolean;
    stride: number;
    offset: number;
    bufferId: number;
}

export interface CapturedVAO {
    id: number;
    attributes: VertexAttribute[];
    indexBufferId: number | null;
}

export interface CapturedTexture {
    id: number;
    target: number;    // TEXTURE_2D, TEXTURE_CUBE_MAP, etc.
    internalFormat: number;
    width: number;
    height: number;
    format: number;
    type: number;
    data: ArrayBuffer | null;
    compressed: boolean;
    mipmaps: number;
    label: string;     // derived: albedo, normal, metallic, emissive, etc.
}

export interface CapturedShader {
    id: number;
    type: number;      // VERTEX_SHADER | FRAGMENT_SHADER
    source: string;
}

export interface CapturedProgram {
    id: number;
    vertexShader: CapturedShader;
    fragmentShader: CapturedShader;
    uniforms: Map<string, UniformInfo>;
    attributes: Map<string, number>;
}

export interface UniformInfo {
    name: string;
    type: number;
    location: number;
    value: unknown;
}

/* ------------------------------------------------------------------ */
/*  Draw Calls                                                        */
/* ------------------------------------------------------------------ */

export interface CapturedDrawCall {
    index: number;
    mode: number;       // gl.TRIANGLES, gl.LINES, etc.
    count: number;
    offset: number;
    instanceCount: number;
    programId: number;
    vaoId: number;
    textureBindings: TextureBinding[];
    uniformSnapshot: Record<string, unknown>;
    framebufferId: number | null;
    viewport: [number, number, number, number];
    depthTest: boolean;
    blend: boolean;
    cullFace: boolean;
    indexed: boolean;
    indexType: number;
}

export interface TextureBinding {
    unit: number;
    target: number;
    textureId: number;
    samplerUniform: string;
}

/* ------------------------------------------------------------------ */
/*  Reconstructed Scene                                               */
/* ------------------------------------------------------------------ */

export interface RipMesh {
    name: string;
    primitives: RipPrimitive[];
}

export interface RipPrimitive {
    positions: Float32Array;
    normals: Float32Array | null;
    tangents: Float32Array | null;
    uvs: Float32Array | null;
    uvs2: Float32Array | null;
    colors: Float32Array | null;
    jointIndices: Uint16Array | null;
    jointWeights: Float32Array | null;
    indices: Uint16Array | Uint32Array | null;
    materialIndex: number;
    mode: number;
    vertexCount: number;
}

export interface RipMaterial {
    name: string;
    programId: number;
    baseColor: [number, number, number, number];
    metallic: number;
    roughness: number;
    emissive: [number, number, number];
    albedoTextureIndex: number | null;
    normalTextureIndex: number | null;
    metallicRoughnessTextureIndex: number | null;
    emissiveTextureIndex: number | null;
    doubleSided: boolean;
    alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
    alphaCutoff: number;
    vertexShaderSource: string;
    fragmentShaderSource: string;
}

export interface RipTexture {
    name: string;
    width: number;
    height: number;
    data: ArrayBuffer;
    format: number | 'rgba' | 'rgb' | 'rg' | 'r';
    compressed: boolean;
    mimeType: string;
}

export interface RipNode {
    name: string;
    meshIndex: number | null;
    children: number[];
    translation: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
}

export interface RipScene {
    name: string;
    nodes: RipNode[];
    meshes: RipMesh[];
    materials: RipMaterial[];
    textures: RipTexture[];
    metadata: RipMetadata;
}

export interface RipMetadata {
    sourceUrl: string;
    capturedAt: string;
    totalDrawCalls: number;
    totalBuffers: number;
    totalTextures: number;
    totalShaders: number;
    captureTimeMs: number;
    rendererInfo: string;
    canvasSize: [number, number];
}

/* ------------------------------------------------------------------ */
/*  Session                                                           */
/* ------------------------------------------------------------------ */

export type RipSessionState =
    | 'idle'
    | 'hooking'
    | 'capturing'
    | 'reconstructing'
    | 'complete'
    | 'error';

export interface RipSessionConfig {
    captureTextures: boolean;
    captureShaders: boolean;
    captureMetadata: boolean;
    maxDrawCalls: number;
    maxTextures: number;
    frameCaptureDuration: number; // ms — how long to capture
    deduplicateBuffers: boolean;
}

export interface RipStats {
    state: RipSessionState;
    drawCallsCaptured: number;
    buffersExtracted: number;
    texturesExtracted: number;
    shadersExtracted: number;
    elapsedMs: number;
    errors: string[];
}

export const DEFAULT_RIP_CONFIG: RipSessionConfig = {
    captureTextures: true,
    captureShaders: true,
    captureMetadata: true,
    maxDrawCalls: 10000,
    maxTextures: 512,
    frameCaptureDuration: 3000,
    deduplicateBuffers: true,
};

/* ------------------------------------------------------------------ */
/*  Events                                                            */
/* ------------------------------------------------------------------ */

export interface RipEventMap {
    'hook:installed': { canvasCount: number };
    'capture:drawcall': { index: number; mode: number; count: number };
    'capture:buffer': { id: number; byteLength: number };
    'capture:texture': { id: number; width: number; height: number };
    'capture:shader': { id: number; type: number };
    'session:statechange': { from: RipSessionState; to: RipSessionState };
    'session:progress': RipStats;
    'session:complete': { scene: RipScene; stats: RipStats };
    'session:error': { message: string };
}
