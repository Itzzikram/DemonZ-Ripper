/**
 * RipSession — Top-level session controller.
 *
 * Orchestrates the WebGL hook, all extractors, and the scene
 * reconstructor into a single start/stop/getResults API.
 */

import {
    type RipSessionConfig,
    type RipSessionState,
    type RipStats,
    type RipScene,
    type RipEventMap,
    DEFAULT_RIP_CONFIG,
} from '../types';
import { WebGLHook, type HookCallbacks } from '../hook/webgl-hook';
import { DrawCallCapture } from '../capture/draw-call-capture';
import { BufferExtractor } from '../capture/buffer-extractor';
import { TextureExtractor } from '../capture/texture-extractor';
import { ShaderExtractor } from '../capture/shader-extractor';
import { SceneReconstructor } from '../scene/scene-reconstructor';

type EventCallback<K extends keyof RipEventMap> = (data: RipEventMap[K]) => void;

export class RipSession {
    private state: RipSessionState = 'idle';
    private config: RipSessionConfig;
    private startTime = 0;
    private errors: string[] = [];
    private scene: RipScene | null = null;

    /* Sub-systems */
    readonly hook = new WebGLHook();
    readonly drawCapture: DrawCallCapture;
    readonly bufferExtractor = new BufferExtractor();
    readonly textureExtractor = new TextureExtractor();
    readonly shaderExtractor = new ShaderExtractor();

    /* Event listeners */
    private listeners = new Map<string, Set<Function>>();

    /* Auto-stop timer */
    private captureTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(config?: Partial<RipSessionConfig>) {
        this.config = { ...DEFAULT_RIP_CONFIG, ...config };
        this.drawCapture = new DrawCallCapture(this.hook);
    }

    /* --------------------------------------------------------------- */
    /*  Public API                                                      */
    /* --------------------------------------------------------------- */

    start(): void {
        if (this.state !== 'idle') return;

        this.setState('hooking');
        this.startTime = performance.now();
        this.errors = [];
        this.scene = null;

        // Reset extractors
        this.hook.resetIds();
        this.drawCapture.clear();
        this.bufferExtractor.clear();
        this.textureExtractor.clear();
        this.shaderExtractor.clear();

        // Build callback bridge
        const callbacks: HookCallbacks = {
            onBufferData: (id, tgt, data, usage) => {
                this.bufferExtractor.captureBufferData(id, tgt, data, usage);
                this.emit('capture:buffer', { id, byteLength: data.byteLength });
            },
            onBufferSubData: (id, tgt, offset, data) => {
                this.bufferExtractor.captureBufferSubData(id, tgt, offset, data);
            },
            onTexImage2D: (texId, tgt, lv, intFmt, w, h, fmt, type, px) => {
                if (this.config.captureTextures) {
                    this.textureExtractor.captureTexImage2D(texId, tgt, lv, intFmt, w, h, fmt, type, px);
                    this.emit('capture:texture', { id: texId, width: w, height: h });
                }
            },
            onTexImage2DSource: (texId, tgt, lv, intFmt, fmt, type, source) => {
                if (this.config.captureTextures) {
                    this.textureExtractor.captureTexImageSource(texId, tgt, lv, intFmt, fmt, type, source);
                }
            },
            onCompressedTexImage2D: (texId, tgt, lv, intFmt, w, h, data) => {
                if (this.config.captureTextures) {
                    this.textureExtractor.captureCompressedTexImage2D(texId, tgt, lv, intFmt, w, h, data);
                    this.emit('capture:texture', { id: texId, width: w, height: h });
                }
            },
            onShaderSource: (id, type, source) => {
                if (this.config.captureShaders) {
                    this.shaderExtractor.captureShaderSource(id, type, source);
                    this.emit('capture:shader', { id, type });
                }
            },
            onLinkProgram: (pid, vsId, fsId) => {
                this.shaderExtractor.captureLinkProgram(pid, vsId, fsId);
            },
            onUseProgram: () => { },
            onUniform: (pid, name, type, value) => {
                this.shaderExtractor.captureUniform(pid, name, type, value);
            },
            onGetUniformLocation: () => {
                // Tracking is done inside WebGLHook.uniformNames map
            },
            onVertexAttribPointer: (loc, size, type, norm, stride, offset) => {
                this.bufferExtractor.captureVertexAttribPointer(loc, size, type, norm, stride, offset);
            },
            onBindBuffer: (tgt, id) => {
                this.bufferExtractor.onBindBuffer(tgt, id);
            },
            onBindTexture: () => { },
            onBindFramebuffer: () => { },
            onBindVertexArray: (id) => {
                this.bufferExtractor.onBindVertexArray(id);
            },
            onDrawArrays: (mode, first, count) => {
                this.drawCapture.captureDrawArrays(mode, first, count);
                this.emit('capture:drawcall', { index: this.drawCapture.getCount() - 1, mode, count });
                this.checkLimits();
            },
            onDrawElements: (mode, count, type, offset) => {
                this.drawCapture.captureDrawElements(mode, count, type, offset);
                this.emit('capture:drawcall', { index: this.drawCapture.getCount() - 1, mode, count });
                this.checkLimits();
            },
            onDrawArraysInstanced: (mode, first, count, instCount) => {
                this.drawCapture.captureDrawArraysInstanced(mode, first, count, instCount);
                this.emit('capture:drawcall', { index: this.drawCapture.getCount() - 1, mode, count });
                this.checkLimits();
            },
            onDrawElementsInstanced: (mode, count, type, offset, instCount) => {
                this.drawCapture.captureDrawElementsInstanced(mode, count, type, offset, instCount);
                this.emit('capture:drawcall', { index: this.drawCapture.getCount() - 1, mode, count });
                this.checkLimits();
            },
            onDrawRangeElements: (mode, _start, _end, count, type, offset) => {
                this.drawCapture.captureDrawRangeElements(mode, _start, _end, count, type, offset);
                this.emit('capture:drawcall', { index: this.drawCapture.getCount() - 1, mode, count });
                this.checkLimits();
            },
        };

        try {
            this.hook.install(callbacks);
            this.setState('capturing');
            this.emit('hook:installed', { canvasCount: document.querySelectorAll('canvas').length });

            // Auto-stop after configured duration
            this.captureTimer = setTimeout(() => {
                this.stopCapture();
            }, this.config.frameCaptureDuration);
        } catch (err: unknown) {
            this.errors.push(err instanceof Error ? err.message : String(err));
            this.setState('error');
            this.emit('session:error', { message: this.errors[this.errors.length - 1] });
        }
    }

    stop(): void {
        this.stopCapture();
    }

    getResults(): RipScene | null {
        return this.scene;
    }

    getStats(): RipStats {
        return {
            state: this.state,
            drawCallsCaptured: this.drawCapture.getCount(),
            buffersExtracted: this.bufferExtractor.getBufferCount(),
            texturesExtracted: this.textureExtractor.getTextureCount(),
            shadersExtracted: this.shaderExtractor.getShaderCount(),
            elapsedMs: this.startTime > 0 ? performance.now() - this.startTime : 0,
            errors: [...this.errors],
        };
    }

    getState(): RipSessionState {
        return this.state;
    }

    /* --------------------------------------------------------------- */
    /*  Events                                                          */
    /* --------------------------------------------------------------- */

    on<K extends keyof RipEventMap>(event: K, callback: EventCallback<K>): void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(callback);
    }

    off<K extends keyof RipEventMap>(event: K, callback: EventCallback<K>): void {
        this.listeners.get(event)?.delete(callback);
    }

    private emitting = false;

    private emit<K extends keyof RipEventMap>(event: K, data: RipEventMap[K]): void {
        const cbs = this.listeners.get(event);
        if (cbs) {
            for (const cb of cbs) {
                try {
                    (cb as EventCallback<K>)(data);
                } catch { /* isolate listener errors */ }
            }
        }

        // Always emit progress on capture events (with recursion guard)
        if (!this.emitting && event.toString().startsWith('capture:')) {
            this.emitting = true;
            try {
                this.emit('session:progress' as K, this.getStats() as RipEventMap[K]);
            } finally {
                this.emitting = false;
            }
        }
    }

    /* --------------------------------------------------------------- */
    /*  Internal                                                        */
    /* --------------------------------------------------------------- */

    private stopCapture(): void {
        if (this.state !== 'capturing') return;

        if (this.captureTimer) {
            clearTimeout(this.captureTimer);
            this.captureTimer = null;
        }

        this.hook.uninstall();
        this.setState('reconstructing');

        try {
            // Optionally deduplicate buffers
            if (this.config.deduplicateBuffers) {
                this.bufferExtractor.deduplicateBuffers();
            }

            const reconstructor = new SceneReconstructor(
                this.bufferExtractor,
                this.textureExtractor,
                this.shaderExtractor,
            );

            this.scene = reconstructor.reconstruct(
                this.drawCapture.getDrawCalls(),
                window.location?.href ?? 'unknown',
                performance.now() - this.startTime,
            );

            this.setState('complete');
            this.emit('session:complete', { scene: this.scene, stats: this.getStats() });
        } catch (err: unknown) {
            this.errors.push(err instanceof Error ? err.message : String(err));
            this.setState('error');
            this.emit('session:error', { message: this.errors[this.errors.length - 1] });
        }
    }

    private setState(newState: RipSessionState): void {
        const old = this.state;
        this.state = newState;
        this.emit('session:statechange', { from: old, to: newState });
    }

    private checkLimits(): void {
        if (this.drawCapture.getCount() >= this.config.maxDrawCalls) {
            this.stopCapture();
        }
        if (this.textureExtractor.getTextureCount() >= this.config.maxTextures) {
            // Don't stop fully, just stop capturing new textures
            this.config.captureTextures = false;
        }
    }

    /* --------------------------------------------------------------- */
    /*  Serialization for headless browser extraction                   */
    /* --------------------------------------------------------------- */

    /**
     * Serialize all captured data for transfer out of a Puppeteer page context.
     * Returns a JSON-serializable object.
     */
    serialize(): Record<string, unknown> {
        return {
            stats: this.getStats(),
            drawCalls: this.drawCapture.getDrawCalls().map((dc) => ({
                ...dc,
                textureBindings: dc.textureBindings,
            })),
            buffers: this.bufferExtractor.getAllBuffers().map((b) => ({
                id: b.id,
                target: b.target,
                usage: b.usage,
                byteLength: b.byteLength,
                data: RipSession.arrayBufferToBase64(b.data),
            })),
            textures: this.textureExtractor.getAllTextures().map((t) => ({
                ...t,
                data: t.data ? RipSession.arrayBufferToBase64(t.data) : null,
            })),
            shaders: this.shaderExtractor.getAllShaders(),
            programs: this.shaderExtractor.getAllPrograms().map((p) => ({
                id: p.id,
                vertexShader: p.vertexShader,
                fragmentShader: p.fragmentShader,
                uniforms: Object.fromEntries(p.uniforms),
                attributes: Object.fromEntries(p.attributes),
            })),
            attributes: Object.fromEntries(
                Array.from(this.bufferExtractor.getAllAttributes().entries()).map(
                    ([vaoId, attrs]) => [vaoId, attrs],
                ),
            ),
        };
    }

    /**
     * Convert ArrayBuffer to Base64 string — ~8x smaller than JSON number arrays
     * and avoids the memory bomb that crashes Puppeteer on large scenes.
     * Uses chunked String.fromCharCode.apply to avoid stack overflow on large buffers.
     */
    private static arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        const CHUNK = 8192;
        const parts: string[] = [];
        for (let i = 0; i < bytes.length; i += CHUNK) {
            const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
            parts.push(String.fromCharCode.apply(null, Array.from(slice)));
        }
        return btoa(parts.join(''));
    }
}
