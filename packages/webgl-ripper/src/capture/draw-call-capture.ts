/**
 * DrawCallCapture — Records every draw call with full GL state snapshot.
 * Queries actual GL state (viewport, depth, blend, cull face) for accurate capture.
 */

import type { CapturedDrawCall, TextureBinding } from '../types';
import type { WebGLHook } from '../hook/webgl-hook';

export class DrawCallCapture {
    private drawCalls: CapturedDrawCall[] = [];
    private drawIndex = 0;

    constructor(private hook: WebGLHook) { }

    captureDrawArrays(mode: number, first: number, count: number): void {
        this.recordDrawCall(mode, count, first, 1, false, 0);
    }

    captureDrawElements(mode: number, count: number, type: number, offset: number): void {
        this.recordDrawCall(mode, count, offset, 1, true, type);
    }

    captureDrawArraysInstanced(mode: number, first: number, count: number, instanceCount: number): void {
        this.recordDrawCall(mode, count, first, instanceCount, false, 0);
    }

    captureDrawElementsInstanced(mode: number, count: number, type: number, offset: number, instanceCount: number): void {
        this.recordDrawCall(mode, count, offset, instanceCount, true, type);
    }

    captureDrawRangeElements(mode: number, _start: number, _end: number, count: number, type: number, offset: number): void {
        this.recordDrawCall(mode, count, offset, 1, true, type);
    }

    private recordDrawCall(
        mode: number,
        count: number,
        offset: number,
        instanceCount: number,
        indexed: boolean,
        indexType: number,
    ): void {
        // Query actual GL state from the context
        const gl = this.hook.getContext();
        const rawViewport = gl ? gl.getParameter(gl.VIEWPORT) : null;
        const viewport = rawViewport instanceof Int32Array
            ? rawViewport
            : new Int32Array([0, 0, 0, 0]);
        const depthTest = gl ? gl.isEnabled(gl.DEPTH_TEST) : true;
        const blend = gl ? gl.isEnabled(gl.BLEND) : false;
        const cullFace = gl ? gl.isEnabled(gl.CULL_FACE) : true;

        const dc: CapturedDrawCall = {
            index: this.drawIndex++,
            mode,
            count,
            offset,
            instanceCount,
            programId: this.hook.currentProgram,
            vaoId: this.hook.currentVao,
            textureBindings: this.hook.getActiveTextureBindings(),
            uniformSnapshot: {},
            framebufferId: this.hook.currentFramebuffer,
            viewport: [viewport[0], viewport[1], viewport[2], viewport[3]],
            depthTest,
            blend,
            cullFace,
            indexed,
            indexType,
        };

        this.drawCalls.push(dc);
    }

    getDrawCalls(): CapturedDrawCall[] {
        return this.drawCalls;
    }

    getCount(): number {
        return this.drawCalls.length;
    }

    clear(): void {
        this.drawCalls = [];
        this.drawIndex = 0;
    }
}
