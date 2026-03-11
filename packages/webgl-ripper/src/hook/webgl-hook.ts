/**
 * WebGLHook — Core WebGL2 API interception via Proxy.
 *
 * Monkey-patches HTMLCanvasElement.prototype.getContext to wrap every
 * WebGL2RenderingContext returned. All intercepted calls are forwarded
 * to the registered extractors (buffers, textures, shaders, draw calls).
 *
 * Also supports WebGL1 contexts with graceful degradation (VAO ops
 * are skipped when OES_vertex_array_object is not available).
 */

import type {
    CapturedBuffer,
    CapturedVAO,
    VertexAttribute,
    TextureBinding,
} from '../types';

/* ---------- callback signatures ---------- */

export interface HookCallbacks {
    onBufferData(bufferId: number, target: number, data: ArrayBuffer, usage: number): void;
    onBufferSubData(bufferId: number, target: number, offset: number, data: ArrayBuffer): void;
    onTexImage2D(texId: number, target: number, level: number, internalFmt: number, w: number, h: number, fmt: number, type: number, pixels: ArrayBufferView | null): void;
    onTexImage2DSource(texId: number, target: number, level: number, internalFmt: number, fmt: number, type: number, source: TexImageSource): void;
    onCompressedTexImage2D(texId: number, target: number, level: number, internalFmt: number, w: number, h: number, data: ArrayBufferView): void;
    onShaderSource(shaderId: number, type: number, source: string): void;
    onLinkProgram(programId: number, vsId: number, fsId: number): void;
    onUseProgram(programId: number): void;
    onUniform(programId: number, name: string, type: string, value: unknown): void;
    onVertexAttribPointer(location: number, size: number, type: number, normalized: boolean, stride: number, offset: number): void;
    onBindBuffer(target: number, bufferId: number): void;
    onBindTexture(unit: number, target: number, texId: number): void;
    onBindFramebuffer(target: number, fbId: number | null): void;
    onBindVertexArray(vaoId: number | null): void;
    onDrawArrays(mode: number, first: number, count: number): void;
    onDrawElements(mode: number, count: number, type: number, offset: number): void;
    onDrawArraysInstanced(mode: number, first: number, count: number, instanceCount: number): void;
    onDrawElementsInstanced(mode: number, count: number, type: number, offset: number, instanceCount: number): void;
    onDrawRangeElements(mode: number, start: number, end: number, count: number, type: number, offset: number): void;
    onGetUniformLocation(programId: number, name: string, location: WebGLUniformLocation): void;
}

/* ---------- WebGLHook ---------- */

export class WebGLHook {
    private active = false;
    private originalGetContext: typeof HTMLCanvasElement.prototype.getContext | null = null;
    private callbacks: HookCallbacks | null = null;

    /* Per-instance ID counters (reset per session) */
    private nextBufferId = 1;
    private nextTextureId = 1;
    private nextShaderId = 1;
    private nextProgramId = 1;
    private nextVaoId = 1;
    private nextFramebufferId = 1;
    readonly framebufferIds = new WeakMap<WebGLFramebuffer, number>();

    /* Maps WebGL native objects → our numeric IDs */
    readonly bufferIds = new WeakMap<WebGLBuffer, number>();
    readonly textureIds = new WeakMap<WebGLTexture, number>();
    readonly shaderIds = new WeakMap<WebGLShader, number>();
    readonly programIds = new WeakMap<WebGLProgram, number>();
    readonly vaoIds = new WeakMap<WebGLVertexArrayObject, number>();

    /* Reverse maps for lookups */
    readonly shaderTypes = new Map<number, number>();           // shaderId → type
    readonly programShaders = new Map<number, [number, number]>(); // progId → [vsId, fsId]

    /* Uniform location → name mapping (proper tracking) */
    readonly uniformNames = new Map<WebGLUniformLocation, string>();

    /* Current GL state tracking */
    currentProgram = 0;
    currentVao = 0;
    currentFramebuffer: number | null = null;
    boundBuffers = new Map<number, number>();            // target → bufferId
    activeTextureUnit = 0;
    textureBindings = new Map<number, Map<number, number>>(); // unit → target → texId

    /* WebGL version detected */
    private isWebGL2 = false;

    /** The wrapped GL context, stored for state querying by extractors */
    private wrappedContext: WebGL2RenderingContext | null = null;

    /** Get the underlying WebGL context (if hooked). */
    getContext(): WebGL2RenderingContext | null {
        return this.wrappedContext;
    }

    install(callbacks: HookCallbacks): void {
        if (this.active) return;
        this.callbacks = callbacks;
        this.active = true;

        const self = this;
        this.originalGetContext = HTMLCanvasElement.prototype.getContext;

        HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            contextId: string,
            options?: unknown,
        ): RenderingContext | null {
            const ctx = self.originalGetContext!.call(this, contextId, options);
            if (!ctx) return ctx;
            if (contextId === 'webgl2') {
                self.isWebGL2 = true;
                return self.wrapContext(ctx as WebGL2RenderingContext);
            }
            if (contextId === 'webgl') {
                self.isWebGL2 = false;
                return self.wrapContext(ctx as WebGL2RenderingContext);
            }
            return ctx;
        } as typeof HTMLCanvasElement.prototype.getContext;
    }

    uninstall(): void {
        if (!this.active || !this.originalGetContext) return;
        HTMLCanvasElement.prototype.getContext = this.originalGetContext;
        this.originalGetContext = null;
        this.active = false;
    }

    get isActive(): boolean {
        return this.active;
    }

    /* --------------------------------------------------------------- */
    /*  Context wrapping                                                */
    /* --------------------------------------------------------------- */

    private wrapContext(gl: WebGL2RenderingContext): WebGL2RenderingContext {
        const self = this;
        if (!this.callbacks) {
            throw new Error('WebGLHook.install() must be called before wrapping context');
        }
        const cb = this.callbacks;
        const isGL2 = this.isWebGL2;

        const proxy = new Proxy(gl, {
            get(target, prop, receiver) {
                const original = Reflect.get(target, prop, receiver);
                if (typeof original !== 'function') return original;

                const name = prop as string;

                /* ---- Buffer ops ---- */
                if (name === 'createBuffer') {
                    return function () {
                        const buf = original.call(target);
                        if (buf) self.bufferIds.set(buf, self.nextBufferId++);
                        return buf;
                    };
                }
                if (name === 'bindBuffer') {
                    return function (tgt: number, buf: WebGLBuffer | null) {
                        const id = buf ? self.bufferIds.get(buf) ?? 0 : 0;
                        self.boundBuffers.set(tgt, id);
                        cb.onBindBuffer(tgt, id);
                        return original.call(target, tgt, buf);
                    };
                }
                if (name === 'bufferData') {
                    return function (tgt: number, dataOrSize: unknown, usage: number) {
                        original.call(target, tgt, dataOrSize, usage);
                        const id = self.boundBuffers.get(tgt) ?? 0;
                        if (id && dataOrSize instanceof ArrayBuffer) {
                            cb.onBufferData(id, tgt, dataOrSize, usage);
                        } else if (id && ArrayBuffer.isView(dataOrSize)) {
                            cb.onBufferData(id, tgt, (dataOrSize.buffer as ArrayBuffer).slice(
                                dataOrSize.byteOffset,
                                dataOrSize.byteOffset + dataOrSize.byteLength,
                            ), usage);
                        }
                    };
                }
                if (name === 'bufferSubData') {
                    return function (tgt: number, offset: number, data: ArrayBufferView) {
                        original.call(target, tgt, offset, data);
                        const id = self.boundBuffers.get(tgt) ?? 0;
                        if (id) {
                            cb.onBufferSubData(id, tgt, offset, (data.buffer as ArrayBuffer).slice(
                                data.byteOffset,
                                data.byteOffset + data.byteLength,
                            ));
                        }
                    };
                }

                /* ---- Texture ops ---- */
                if (name === 'createTexture') {
                    return function () {
                        const tex = original.call(target);
                        if (tex) self.textureIds.set(tex, self.nextTextureId++);
                        return tex;
                    };
                }
                if (name === 'activeTexture') {
                    return function (unit: number) {
                        self.activeTextureUnit = unit - target.TEXTURE0;
                        return original.call(target, unit);
                    };
                }
                if (name === 'bindTexture') {
                    return function (tgt2: number, tex: WebGLTexture | null) {
                        const id = tex ? self.textureIds.get(tex) ?? 0 : 0;
                        if (!self.textureBindings.has(self.activeTextureUnit)) {
                            self.textureBindings.set(self.activeTextureUnit, new Map());
                        }
                        self.textureBindings.get(self.activeTextureUnit)!.set(tgt2, id);
                        cb.onBindTexture(self.activeTextureUnit, tgt2, id);
                        return original.call(target, tgt2, tex);
                    };
                }
                if (name === 'texImage2D') {
                    return function (...args: unknown[]) {
                        (original as Function).apply(target, args);
                        /* texImage2D has many overloads — handle the common 9-arg form */
                        if (args.length >= 9) {
                            const [tgt2, level, intFmt, w, h, , fmt, type, pixels] = args as [
                                number, number, number, number, number, number, number, number, ArrayBufferView | null,
                            ];
                            const texMap = self.textureBindings.get(self.activeTextureUnit);
                            const texId = texMap?.get(tgt2 as number) ?? 0;
                            cb.onTexImage2D(texId, tgt2, level, intFmt, w, h, fmt, type, pixels ?? null);
                        }
                        /* 6-arg form (source is HTMLImageElement/Canvas/etc) */
                        if (args.length === 6) {
                            const [tgt2, level, intFmt, fmt, type, source] = args as [
                                number, number, number, number, number, unknown,
                            ];
                            const texMap = self.textureBindings.get(self.activeTextureUnit);
                            const texId = texMap?.get(tgt2 as number) ?? 0;
                            let w = 0, h = 0;
                            if (source && typeof source === 'object') {
                                w = (source as HTMLImageElement).width ?? (source as HTMLImageElement).naturalWidth ?? 0;
                                h = (source as HTMLImageElement).height ?? (source as HTMLImageElement).naturalHeight ?? 0;
                            }
                            cb.onTexImage2D(texId, tgt2, level, intFmt, w, h, fmt, type, null);
                            // Also notify about the image source for readback
                            if (source && (source instanceof HTMLImageElement || source instanceof HTMLCanvasElement || source instanceof ImageBitmap)) {
                                cb.onTexImage2DSource(texId, tgt2, level, intFmt, fmt, type, source as TexImageSource);
                            }
                        }
                    };
                }
                if (name === 'compressedTexImage2D') {
                    return function (...args: unknown[]) {
                        (original as Function).apply(target, args);
                        if (args.length >= 7) {
                            const [tgt2, level, intFmt, w, h, , data] = args as [
                                number, number, number, number, number, number, ArrayBufferView,
                            ];
                            const texMap = self.textureBindings.get(self.activeTextureUnit);
                            const texId = texMap?.get(tgt2 as number) ?? 0;
                            cb.onCompressedTexImage2D(texId, tgt2, level, intFmt, w, h, data);
                        }
                    };
                }

                /* ---- Shader / program ops ---- */
                if (name === 'createShader') {
                    return function (type: number) {
                        const s = original.call(target, type);
                        if (s) {
                            const id = self.nextShaderId++;
                            self.shaderIds.set(s, id);
                            self.shaderTypes.set(id, type);
                        }
                        return s;
                    };
                }
                if (name === 'shaderSource') {
                    return function (shader: WebGLShader, source: string) {
                        const id = self.shaderIds.get(shader) ?? 0;
                        const type = self.shaderTypes.get(id) ?? 0;
                        cb.onShaderSource(id, type, source);
                        return original.call(target, shader, source);
                    };
                }
                if (name === 'createProgram') {
                    return function () {
                        const p = original.call(target);
                        if (p) self.programIds.set(p, self.nextProgramId++);
                        return p;
                    };
                }
                if (name === 'attachShader') {
                    return function (program: WebGLProgram, shader: WebGLShader) {
                        const pid = self.programIds.get(program) ?? 0;
                        const sid = self.shaderIds.get(shader) ?? 0;
                        const type = self.shaderTypes.get(sid) ?? 0;
                        const existing = self.programShaders.get(pid) ?? [0, 0];
                        if (type === target.VERTEX_SHADER) existing[0] = sid;
                        else existing[1] = sid;
                        self.programShaders.set(pid, existing as [number, number]);
                        return original.call(target, program, shader);
                    };
                }
                if (name === 'linkProgram') {
                    return function (program: WebGLProgram) {
                        original.call(target, program);
                        const pid = self.programIds.get(program) ?? 0;
                        const [vsId, fsId] = self.programShaders.get(pid) ?? [0, 0];
                        cb.onLinkProgram(pid, vsId, fsId);
                    };
                }
                if (name === 'useProgram') {
                    return function (program: WebGLProgram | null) {
                        const pid = program ? self.programIds.get(program) ?? 0 : 0;
                        self.currentProgram = pid;
                        cb.onUseProgram(pid);
                        return original.call(target, program);
                    };
                }

                /* ---- Uniform location tracking (proper name resolution) ---- */
                if (name === 'getUniformLocation') {
                    return function (program: WebGLProgram, uniformName: string) {
                        const loc = original.call(target, program, uniformName);
                        if (loc) {
                            const pid = self.programIds.get(program) ?? 0;
                            self.uniformNames.set(loc, uniformName);
                            cb.onGetUniformLocation(pid, uniformName, loc);
                        }
                        return loc;
                    };
                }

                /* ---- Uniform ops (track values) ---- */
                if (name.startsWith('uniform') && !name.includes('Block')) {
                    return function (...args: unknown[]) {
                        (original as Function).apply(target, args);
                        const loc = args[0] as WebGLUniformLocation | null;
                        if (!loc) return;
                        // Look up the real name from our tracked map
                        const uniformName = self.uniformNames.get(loc) ?? `unknown_${name}`;
                        const value = args.length === 2 ? args[1] : Array.from(args.slice(1));
                        cb.onUniform(self.currentProgram, uniformName, name, value);
                    };
                }

                /* ---- VAO ops (WebGL2 only, skip for WebGL1) ---- */
                if (name === 'createVertexArray') {
                    if (!isGL2) return original.bind(target);
                    return function () {
                        const vao = original.call(target);
                        if (vao) self.vaoIds.set(vao, self.nextVaoId++);
                        return vao;
                    };
                }
                if (name === 'bindVertexArray') {
                    if (!isGL2) return original.bind(target);
                    return function (vao: WebGLVertexArrayObject | null) {
                        const id = vao ? self.vaoIds.get(vao) ?? 0 : 0;
                        self.currentVao = id;
                        cb.onBindVertexArray(id || null);
                        return original.call(target, vao);
                    };
                }
                if (name === 'vertexAttribPointer') {
                    return function (loc: number, size: number, type: number, norm: boolean, stride: number, offset: number) {
                        cb.onVertexAttribPointer(loc, size, type, norm, stride, offset);
                        return original.call(target, loc, size, type, norm, stride, offset);
                    };
                }

                /* ---- Framebuffer ops ---- */
                if (name === 'createFramebuffer') {
                    return function () {
                        const fb = original.call(target);
                        if (fb) self.framebufferIds.set(fb, self.nextFramebufferId++);
                        return fb;
                    };
                }
                if (name === 'bindFramebuffer') {
                    return function (tgt2: number, fb: WebGLFramebuffer | null) {
                        const id = fb ? (self.framebufferIds.get(fb) ?? 1) : null;
                        self.currentFramebuffer = id;
                        cb.onBindFramebuffer(tgt2, id);
                        return original.call(target, tgt2, fb);
                    };
                }

                /* ---- Draw calls ---- */
                if (name === 'drawArrays') {
                    return function (mode: number, first: number, count: number) {
                        cb.onDrawArrays(mode, first, count);
                        return original.call(target, mode, first, count);
                    };
                }
                if (name === 'drawElements') {
                    return function (mode: number, count: number, type: number, offset: number) {
                        cb.onDrawElements(mode, count, type, offset);
                        return original.call(target, mode, count, type, offset);
                    };
                }
                if (name === 'drawArraysInstanced') {
                    return function (mode: number, first: number, count: number, instanceCount: number) {
                        cb.onDrawArraysInstanced(mode, first, count, instanceCount);
                        return original.call(target, mode, first, count, instanceCount);
                    };
                }
                if (name === 'drawElementsInstanced') {
                    return function (mode: number, count: number, type: number, offset: number, instanceCount: number) {
                        cb.onDrawElementsInstanced(mode, count, type, offset, instanceCount);
                        return original.call(target, mode, count, type, offset, instanceCount);
                    };
                }
                if (name === 'drawRangeElements') {
                    return function (mode: number, start: number, end: number, count: number, type: number, offset: number) {
                        cb.onDrawRangeElements(mode, start, end, count, type, offset);
                        return original.call(target, mode, start, end, count, type, offset);
                    };
                }

                /* ---- Pass-through ---- */
                return original.bind(target);
            },
        });

        self.wrappedContext = proxy;
        return proxy;
    }

    /* --------------------------------------------------------------- */
    /*  Helpers                                                         */
    /* --------------------------------------------------------------- */

    getActiveTextureBindings(): TextureBinding[] {
        const bindings: TextureBinding[] = [];
        for (const [unit, targets] of this.textureBindings) {
            for (const [target, texId] of targets) {
                if (texId > 0) {
                    bindings.push({ unit, target, textureId: texId, samplerUniform: '' });
                }
            }
        }
        return bindings;
    }

    resetIds(): void {
        this.nextBufferId = 1;
        this.nextTextureId = 1;
        this.nextShaderId = 1;
        this.nextProgramId = 1;
        this.nextVaoId = 1;
        this.nextFramebufferId = 1;

        // Clear state tracking maps (WeakMaps are automatically GC'd,
        // but Maps accumulate across sessions)
        this.shaderTypes.clear();
        this.programShaders.clear();
        this.uniformNames.clear();
        this.boundBuffers.clear();
        this.textureBindings.clear();
        this.currentProgram = 0;
        this.currentVao = 0;
        this.currentFramebuffer = null;
        this.activeTextureUnit = 0;
        this.wrappedContext = null;
    }
}
