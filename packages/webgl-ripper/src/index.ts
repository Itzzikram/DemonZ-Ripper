/**
 * @platform/webgl-ripper — Public API
 *
 * Client-side WebGL2 interception engine for extracting 3D assets
 * (meshes, textures, shaders, metadata) from WebGL-rendered scenes.
 */

// Types
export type {
    CapturedBuffer,
    CapturedVAO,
    VertexAttribute,
    CapturedTexture,
    CapturedShader,
    CapturedProgram,
    UniformInfo,
    CapturedDrawCall,
    TextureBinding,
    RipMesh,
    RipPrimitive,
    RipMaterial,
    RipTexture,
    RipNode,
    RipScene,
    RipMetadata,
    RipSessionConfig,
    RipSessionState,
    RipStats,
    RipEventMap,
} from './types';

export { DEFAULT_RIP_CONFIG } from './types';

// Hook
export { WebGLHook } from './hook/webgl-hook';
export type { HookCallbacks } from './hook/webgl-hook';

// Capture modules
export { DrawCallCapture } from './capture/draw-call-capture';
export { BufferExtractor } from './capture/buffer-extractor';
export { TextureExtractor } from './capture/texture-extractor';
export { ShaderExtractor } from './capture/shader-extractor';

// Scene
export { SceneReconstructor } from './scene/scene-reconstructor';

// Session
export { RipSession } from './session/rip-session';
