/**
 * TextureExtractor — Captures texture data at upload time.
 * Stores raw pixel data with format/dimensions for later export.
 *
 * For textures uploaded from image elements (where raw pixel data is
 * not directly available), extracts pixels via an offscreen canvas.
 */

import type { CapturedTexture } from '../types';

export class TextureExtractor {
    private textures = new Map<number, CapturedTexture>();
    private maxTextures = 512;
    private corsWarnings: string[] = [];

    setMaxTextures(max: number): void {
        this.maxTextures = max;
    }

    getCorsWarnings(): string[] {
        return [...this.corsWarnings];
    }

    captureTexImage2D(
        texId: number,
        target: number,
        level: number,
        internalFormat: number,
        width: number,
        height: number,
        format: number,
        type: number,
        pixels: ArrayBufferView | null,
    ): void {
        if (texId === 0 || width === 0 || height === 0) return;
        if (this.textures.size >= this.maxTextures && !this.textures.has(texId)) return;

        const existing = this.textures.get(texId);

        // Only store level 0 (base mip); track mip count
        if (level === 0) {
            this.textures.set(texId, {
                id: texId,
                target,
                internalFormat,
                width,
                height,
                format,
                type,
                data: pixels ? (pixels.buffer as ArrayBuffer).slice(
                    pixels.byteOffset,
                    pixels.byteOffset + pixels.byteLength,
                ) : null,
                compressed: false,
                mipmaps: existing ? existing.mipmaps : 1,
                label: this.guessLabel(internalFormat, format),
            });
        } else if (existing) {
            existing.mipmaps = Math.max(existing.mipmaps, level + 1);
        }
    }

    captureCompressedTexImage2D(
        texId: number,
        target: number,
        level: number,
        internalFormat: number,
        width: number,
        height: number,
        data: ArrayBufferView,
    ): void {
        if (texId === 0 || width === 0 || height === 0) return;
        if (this.textures.size >= this.maxTextures && !this.textures.has(texId)) return;

        if (level === 0) {
            this.textures.set(texId, {
                id: texId,
                target,
                internalFormat,
                width,
                height,
                format: internalFormat,
                type: 0,
                data: (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength),
                compressed: true,
                mipmaps: 1,
                label: this.guessLabel(internalFormat, internalFormat),
            });
        }
    }

    /**
     * Extract pixel data from an image source (HTMLImageElement, HTMLCanvasElement,
     * ImageBitmap) using an offscreen canvas. Called when texImage2D is used with
     * an image source instead of raw pixel data.
     */
    captureTexImageSource(
        texId: number,
        target: number,
        level: number,
        internalFormat: number,
        format: number,
        type: number,
        source: TexImageSource,
    ): void {
        if (texId === 0 || level !== 0) return;
        if (this.textures.size >= this.maxTextures && !this.textures.has(texId)) return;

        let width = 0;
        let height = 0;

        if (source instanceof HTMLImageElement) {
            width = source.naturalWidth || source.width;
            height = source.naturalHeight || source.height;
        } else if (source instanceof HTMLCanvasElement) {
            width = source.width;
            height = source.height;
        } else if (source instanceof ImageBitmap) {
            width = source.width;
            height = source.height;
        } else if (source instanceof HTMLVideoElement) {
            width = source.videoWidth;
            height = source.videoHeight;
        }

        if (width === 0 || height === 0) return;

        // Skip if we already have data for this texture
        const existing = this.textures.get(texId);
        if (existing?.data) return;

        try {
            // Use OffscreenCanvas if available, otherwise fall back to DOM canvas
            let pixelData: ArrayBuffer;
            if (typeof OffscreenCanvas !== 'undefined') {
                const offscreen = new OffscreenCanvas(width, height);
                const ctx = offscreen.getContext('2d');
                if (!ctx) return;
                ctx.drawImage(source as CanvasImageSource, 0, 0);
                const imageData = ctx.getImageData(0, 0, width, height);
                pixelData = imageData.data.buffer.slice(0);
            } else {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.drawImage(source as CanvasImageSource, 0, 0);
                const imageData = ctx.getImageData(0, 0, width, height);
                pixelData = imageData.data.buffer.slice(0);
                // Explicitly clean up to avoid DOM leak
                canvas.width = 0;
                canvas.height = 0;
            }

            this.textures.set(texId, {
                id: texId,
                target,
                internalFormat,
                width,
                height,
                format: 0x1908, // RGBA (canvas always gives RGBA)
                type,
                data: pixelData,
                compressed: false,
                mipmaps: existing ? existing.mipmaps : 1,
                label: this.guessLabel(internalFormat, format),
            });
        } catch {
            // CORS or security error — can't read back the image
            // Still store the metadata without pixel data
            this.corsWarnings.push(`CORS: texture ${texId} (${width}x${height}) pixel data unavailable`);
            if (!existing) {
                this.textures.set(texId, {
                    id: texId,
                    target,
                    internalFormat,
                    width,
                    height,
                    format,
                    type,
                    data: null,
                    compressed: false,
                    mipmaps: 1,
                    label: this.guessLabel(internalFormat, format),
                });
            }
        }
    }

    /* ---- Getters ---- */

    getTexture(id: number): CapturedTexture | undefined {
        return this.textures.get(id);
    }

    getAllTextures(): CapturedTexture[] {
        return Array.from(this.textures.values());
    }

    getTextureCount(): number {
        return this.textures.size;
    }

    clear(): void {
        this.textures.clear();
        this.corsWarnings = [];
    }

    /* ---- Helpers ---- */

    private guessLabel(internalFormat: number, format: number): string {
        // Common WebGL2 internal format constants
        const SRGB8_ALPHA8 = 0x8C43;
        const RGBA8 = 0x8058;
        const RG8 = 0x822B;
        const R8 = 0x8229;
        const RGB8 = 0x8051;

        // Can't reliably guess from format alone, but partial heuristics:
        if (internalFormat === RG8 || format === 0x8227 /* RG */) return 'metallic-roughness';
        if (internalFormat === R8) return 'occlusion';
        return 'unknown'; // label is refined during scene reconstruction
    }
}
