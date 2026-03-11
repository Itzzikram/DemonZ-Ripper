/**
 * TexturePacker — Converts raw pixel data from captured textures
 * into standard image formats (PNG/JPEG/WebP) using an OffscreenCanvas.
 * Also handles channel remapping, alpha separation, and format detection.
 */

import type { RipTexture } from '@platform/webgl-ripper';

export type ImageFormat = 'image/png' | 'image/jpeg' | 'image/webp';

export interface PackedTexture {
    name: string;
    data: ArrayBuffer;
    mimeType: string;
    width: number;
    height: number;
    originalFormat: number | string;
}

export class TexturePacker {
    /**
     * Pack all textures from a ripped scene into standard image formats.
     */
    async packAll(
        textures: RipTexture[],
        format: ImageFormat = 'image/png',
        quality = 0.92,
    ): Promise<PackedTexture[]> {
        const packed: PackedTexture[] = [];

        for (const tex of textures) {
            const result = await this.packTexture(tex, format, quality);
            if (result) packed.push(result);
        }

        return packed;
    }

    /**
     * Pack a single texture into the target format.
     */
    async packTexture(
        tex: RipTexture,
        format: ImageFormat = 'image/png',
        quality = 0.92,
    ): Promise<PackedTexture | null> {
        if (!tex.data || tex.data.byteLength === 0) return null;

        // If already compressed (S3TC/ASTC/ETC2), return raw data
        if (tex.compressed) {
            return {
                name: tex.name,
                data: tex.data,
                mimeType: 'application/octet-stream',
                width: tex.width,
                height: tex.height,
                originalFormat: tex.format,
            };
        }

        try {
            // Convert raw pixel data to an image using OffscreenCanvas
            const imageData = this.rawToImageData(tex);
            if (!imageData) return null;

            const canvas = new OffscreenCanvas(tex.width, tex.height);
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;

            ctx.putImageData(imageData, 0, 0);
            const blob = await canvas.convertToBlob({ type: format, quality });
            const arrayBuffer = await blob.arrayBuffer();

            return {
                name: tex.name,
                data: arrayBuffer,
                mimeType: format,
                width: tex.width,
                height: tex.height,
                originalFormat: tex.format,
            };
        } catch {
            // Fallback: return raw data
            return {
                name: tex.name,
                data: tex.data,
                mimeType: 'application/octet-stream',
                width: tex.width,
                height: tex.height,
                originalFormat: tex.format,
            };
        }
    }

    /**
     * Extract a specific channel from a texture (e.g., metallic from RG texture).
     */
    extractChannel(
        tex: RipTexture,
        channel: 'r' | 'g' | 'b' | 'a',
    ): Uint8Array | null {
        if (!tex.data || tex.data.byteLength === 0) return null;

        const pixels = new Uint8Array(tex.data);
        const channelData = new Uint8Array(tex.width * tex.height);
        const channels = this.formatToChannelCount(tex.format);
        const channelIndex = { r: 0, g: 1, b: 2, a: 3 }[channel];

        if (channelIndex >= channels) return null;

        for (let i = 0; i < tex.width * tex.height; i++) {
            channelData[i] = pixels[i * channels + channelIndex];
        }

        return channelData;
    }

    /**
     * Separate alpha channel from an RGBA texture.
     * Returns the RGB texture and a grayscale alpha mask.
     */
    separateAlpha(tex: RipTexture): { rgb: Uint8Array; alpha: Uint8Array } | null {
        // GL_RGBA = 0x1908
        if (tex.format !== 0x1908 || !tex.data) return null;

        const pixels = new Uint8Array(tex.data);
        const pixelCount = tex.width * tex.height;
        const rgb = new Uint8Array(pixelCount * 3);
        const alpha = new Uint8Array(pixelCount);

        for (let i = 0; i < pixelCount; i++) {
            rgb[i * 3] = pixels[i * 4];
            rgb[i * 3 + 1] = pixels[i * 4 + 1];
            rgb[i * 3 + 2] = pixels[i * 4 + 2];
            alpha[i] = pixels[i * 4 + 3];
        }

        return { rgb, alpha };
    }

    /**
     * Detect the likely texture role based on pixel statistics.
     */
    detectTextureType(tex: RipTexture): 'albedo' | 'normal' | 'metallic-roughness' | 'emissive' | 'occlusion' | 'unknown' {
        if (!tex.data || tex.data.byteLength === 0) return 'unknown';

        const pixels = new Uint8Array(tex.data);
        const channels = this.formatToChannelCount(tex.format);
        const pixelCount = tex.width * tex.height;
        if (pixelCount === 0) return 'unknown';

        // Analyze pixel statistics
        let avgR = 0, avgG = 0, avgB = 0;
        let hasColor = false;

        const sampleCount = Math.min(pixelCount, 1000);
        const step = Math.max(1, Math.floor(pixelCount / sampleCount));

        for (let i = 0; i < pixelCount; i += step) {
            const r = pixels[i * channels];
            const g = channels > 1 ? pixels[i * channels + 1] : 0;
            const b = channels > 2 ? pixels[i * channels + 2] : 0;
            avgR += r;
            avgG += g;
            avgB += b;
            if (Math.abs(r - g) > 20 || Math.abs(g - b) > 20) hasColor = true;
        }

        const samples = Math.floor(pixelCount / step);
        avgR /= samples;
        avgG /= samples;
        avgB /= samples;

        // Normal maps: average RGB is close to (128, 128, 255)
        if (Math.abs(avgR - 128) < 30 && Math.abs(avgG - 128) < 30 && avgB > 200) {
            return 'normal';
        }

        // Metallic-roughness: RG texture or grayscale
        // GL_RG = 0x8227
        if (tex.format === 0x8227 || channels <= 2) {
            return 'metallic-roughness';
        }

        // Single channel — GL_RED = 0x1903
        if (tex.format === 0x1903 || channels === 1) {
            return 'occlusion';
        }

        // Colorful = albedo, grayscale might be occlusion
        if (hasColor) return 'albedo';

        return 'unknown';
    }

    /* ---- Internal ---- */

    private rawToImageData(tex: RipTexture): ImageData | null {
        const pixels = new Uint8Array(tex.data);
        const channels = this.formatToChannelCount(tex.format);
        const expectedBytes = tex.width * tex.height * channels;
        if (pixels.length < expectedBytes) return null;
        const rgba = new Uint8ClampedArray(tex.width * tex.height * 4);

        for (let i = 0; i < tex.width * tex.height; i++) {
            rgba[i * 4] = pixels[i * channels];                          // R
            rgba[i * 4 + 1] = channels > 1 ? pixels[i * channels + 1] : pixels[i * channels]; // G
            rgba[i * 4 + 2] = channels > 2 ? pixels[i * channels + 2] : pixels[i * channels]; // B
            rgba[i * 4 + 3] = channels > 3 ? pixels[i * channels + 3] : 255;                  // A
        }

        return new ImageData(rgba, tex.width, tex.height);
    }

    private formatToChannelCount(format: number | string): number {
        // Handle GL enum constants
        switch (format) {
            case 0x1908: return 4;  // GL_RGBA
            case 0x8058: return 4;  // GL_RGBA8
            case 0x8C43: return 4;  // GL_SRGB8_ALPHA8
            case 0x1907: return 3;  // GL_RGB
            case 0x8051: return 3;  // GL_RGB8
            case 0x8C41: return 3;  // GL_SRGB8
            case 0x8227: return 2;  // GL_RG
            case 0x822B: return 2;  // GL_RG8
            case 0x1903: return 1;  // GL_RED
            case 0x8229: return 1;  // GL_R8
            case 0x1906: return 1;  // GL_ALPHA
            case 0x1909: return 1;  // GL_LUMINANCE
            case 0x190A: return 2;  // GL_LUMINANCE_ALPHA
            // Legacy string fallbacks
            case 'rgba': return 4;
            case 'rgb': return 3;
            case 'rg': return 2;
            case 'r': return 1;
            default: return 4;
        }
    }
}
