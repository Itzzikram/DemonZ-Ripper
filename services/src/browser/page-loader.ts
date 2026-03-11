/**
 * PageLoader — Puppeteer-based headless browser controller.
 *
 * Opens a target URL, injects the webgl-ripper hook script,
 * waits for the scene to render, then collects all captured data
 * and exports to the requested format.
 *
 * The injection script is a self-contained inline version of the
 * core ripping logic with per-VAO index buffer tracking, uniform
 * name resolution, WebGL1 compatibility, and image source readback.
 */

import puppeteer, { type Browser, type Page } from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import type { RipScene, RipMesh, RipPrimitive, RipTexture, RipMaterial, RipNode, RipMetadata } from '@platform/webgl-ripper';

const OUTPUT_DIR = path.join(process.cwd(), 'rip-output');

export interface RipPageOptions {
    captureTextures: boolean;
    captureShaders: boolean;
    captureDuration: number;
    waitForLoad: number;
    viewport: { width: number; height: number };
}

export interface RipPageResult {
    glb: ArrayBuffer;
    /** Reconstructed scene — used by format-specific exporters (UAsset, OBJ) */
    scene: RipScene;
    stats: {
        meshCount: number;
        textureCount: number;
        shaderCount: number;
        drawCallCount: number;
        captureTimeMs: number;
    };
    /** Base64-encoded PNG screenshot of the page at capture time */
    screenshot?: string | null;
    /** Console errors/warnings collected from the target page */
    consoleErrors?: string[];
}

/* ---- Blocked URL patterns (SSRF protection) ---- */

const BLOCKED_PATTERNS = [
    /^file:/i,
    /^data:/i,
    /^javascript:/i,
    /^ftp:/i,
    // Block private/internal IP ranges
    /^https?:\/\/localhost(:|\/)*/i,
    /^https?:\/\/127\./,
    /^https?:\/\/0\./,
    /^https?:\/\/0\.0\.0\.0/,
    /^https?:\/\/10\./,
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
    /^https?:\/\/192\.168\./,
    /^https?:\/\/\[::1\]/,
    /^https?:\/\/\[::ffff:/i,
    /^https?:\/\/169\.254\./,
    // Block multicast and reserved ranges
    /^https?:\/\/224\./,
    /^https?:\/\/225\./,
    /^https?:\/\/226\./,
    /^https?:\/\/227\./,
    /^https?:\/\/228\./,
    /^https?:\/\/229\./,
    /^https?:\/\/23[0-9]\./,
    /^https?:\/\/24[0-9]\./,
    /^https?:\/\/25[0-5]\./,
    // Block cloud metadata endpoints
    /^https?:\/\/metadata\.google\.internal/i,
];

/** Well-known internal service ports to block in addition to IP patterns */
const BLOCKED_PORTS = new Set([
    '6379',  // Redis
    '5432',  // PostgreSQL
    '3306',  // MySQL
    '27017', // MongoDB
    '9200',  // Elasticsearch
    '8500',  // Consul
    '2379',  // etcd
    '11211', // Memcached
]);

function isUrlSafe(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        // Block known internal-service ports
        if (parsed.port && BLOCKED_PORTS.has(parsed.port)) return false;
        // Block numeric/hex/octal IP encodings (e.g. 0x7F000001, 2130706433)
        if (/^\d+$/.test(parsed.hostname) || /^0x[0-9a-f]+$/i.test(parsed.hostname) || /^0\d/.test(parsed.hostname)) return false;
        for (const pattern of BLOCKED_PATTERNS) {
            if (pattern.test(url)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

export class PageLoader {
    private browser: Browser | null = null;

    async init(): Promise<void> {
        if (this.browser) return;
        this.browser = await puppeteer.launch({
            headless: 'new' as unknown as boolean,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--use-gl=swiftshader',          // Software WebGL for headless
                '--enable-webgl',
                '--enable-webgl2',
                '--ignore-gpu-blocklist',
                '--disable-plugins',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                // Anti-detection flags
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080',
                // Allow hook injection into cross-origin iframes (viewer embeds)
                '--disable-site-isolation-trials',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });
    }

    async ripPage(url: string, options: RipPageOptions): Promise<RipPageResult> {
        // SSRF protection
        if (!isUrlSafe(url)) {
            throw new Error(`URL blocked by security policy: ${url}`);
        }

        // Validate viewport dimensions to prevent resource exhaustion
        if (options.viewport.width > 3840 || options.viewport.height > 2160 ||
            options.viewport.width < 1 || options.viewport.height < 1) {
            throw new Error(`Viewport dimensions out of range (max 3840x2160): ${options.viewport.width}x${options.viewport.height}`);
        }

        await this.init();
        const page = await this.browser!.newPage();

        // Anti-detection: realistic User-Agent and remove webdriver flag
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        );
        await page.evaluateOnNewDocument(() => {
            // Remove navigator.webdriver flag
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            // Chrome runtime stub (expected by bot-detection scripts)
            (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
            // Permissions API override
            const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
            if (originalQuery) {
                Object.defineProperty(navigator, 'permissions', {
                    get: () => ({
                        query: (p: { name: string }) =>
                            p.name === 'notifications'
                                ? Promise.resolve({ state: 'prompt', onchange: null } as unknown as PermissionStatus)
                                : originalQuery(p),
                    }),
                });
            }
            // Languages
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            // Plugins (headless Chrome has 0; real browsers have some)
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
        });

        // Collect console errors from the page
        const consoleErrors: string[] = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error' || msg.type() === 'warn') {
                consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
            }
        });
        page.on('pageerror', (err) => {
            consoleErrors.push(`[pageerror] ${err.message}`);
        });
        // Log failed network requests for diagnostics
        page.on('requestfailed', (req) => {
            consoleErrors.push(`[reqfail] ${req.url().slice(0, 200)} — ${req.failure()?.errorText ?? 'unknown'}`);
        });
        page.on('response', (resp) => {
            const status = resp.status();
            if (status >= 400) {
                consoleErrors.push(`[http${status}] ${resp.url().slice(0, 200)}`);
            }
            // Log responses that look like 3D model or viewer URLs
            const urlLower = resp.url().toLowerCase();
            if (/\.(glb|gltf|fbx|obj|usd|usdz|bin|draco)(\?|$)/i.test(urlLower) ||
                /sketchfab|viewer|3d|model|embed/i.test(urlLower)) {
                consoleErrors.push(`[3d-url] ${status} ${resp.url().slice(0, 300)}`);
            }
        });

        try {
            await page.setViewport({
                width: options.viewport.width,
                height: options.viewport.height,
                deviceScaleFactor: 1,
            });

            // Inject the WebGL hook BEFORE any page scripts run
            await page.evaluateOnNewDocument(this.getHookScript(options));

            // Navigate to the target URL
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: Math.max(options.waitForLoad + 10000, 30000),
            });

            // Wait for the page to fully load and render
            await new Promise(resolve => setTimeout(resolve, options.waitForLoad));

            // --- Auto-activate 3D viewers on known platforms ---
            await this.tryActivate3DViewer(page, url);

            // Wait for capture duration to complete
            await new Promise(resolve => setTimeout(resolve, options.captureDuration + 500));

            // Take a screenshot before extracting data (useful for thumbnails)
            let screenshotBase64: string | null = null;
            try {
                const screenshotBuffer = await page.screenshot({ type: 'png', encoding: 'base64' }) as string;
                screenshotBase64 = screenshotBuffer;
                // Save diagnostic screenshot to output dir
                const screenshotPath = path.join(OUTPUT_DIR, `screenshot_${Date.now()}.png`);
                fs.writeFileSync(screenshotPath, Buffer.from(screenshotBuffer, 'base64'));
            } catch { /* screenshot is optional */ }

            // Log iframe and canvas diagnostic info (including CDP frame URLs)
            const frameUrls = page.frames().map(f => f.url()).filter(u => u && u !== 'about:blank');
            const diagnostics = await page.evaluate(() => {
                const iframes = document.querySelectorAll('iframe');
                const canvases = document.querySelectorAll('canvas');
                return {
                    iframeCount: iframes.length,
                    iframeSrcs: Array.from(iframes).map(f => f.src).slice(0, 10),
                    canvasCount: canvases.length,
                    canvasSizes: Array.from(canvases).map(c => `${c.width}x${c.height}`),
                    hookState: (globalThis as unknown as { __X_RIPPER_SESSION__?: { getState(): string } }).__X_RIPPER_SESSION__?.getState() ?? 'not installed',
                };
            });
            consoleErrors.push(`[diag] iframes: ${diagnostics.iframeCount}, canvases: ${diagnostics.canvasCount}, hookState: ${diagnostics.hookState}`);
            consoleErrors.push(`[diag] iframeSrcs: ${diagnostics.iframeSrcs.join(', ')}`);
            consoleErrors.push(`[diag] frameUrls(CDP): ${frameUrls.join(', ')}`);
            consoleErrors.push(`[diag] canvasSizes: ${diagnostics.canvasSizes.join(', ')}`);

            // Check sub-frames for hook state and canvases
            for (const frame of page.frames()) {
                if (frame === page.mainFrame()) continue;
                try {
                    const fState = await frame.evaluate(() => {
                        const w = globalThis as unknown as { __X_RIPPER_SESSION__?: { getState(): string } };
                        return w.__X_RIPPER_SESSION__?.getState() ?? 'not installed';
                    });
                    const fCanvases = await frame.evaluate(() => document.querySelectorAll('canvas').length);
                    consoleErrors.push(`[diag] frame ${frame.url()}: hookState=${fState}, canvases=${fCanvases}`);
                } catch { /* detached or inaccessible frame */ }
            }

            // Try to collect capture data from ANY frame (main or sub-frame)
            let capturedData: unknown = null;
            for (const frame of page.frames()) {
                try {
                    const data = await frame.evaluate(() => {
                        const w = globalThis as unknown as { __X_RIPPER_SESSION__?: { serialize(): unknown; getState(): string } };
                        const session = w.__X_RIPPER_SESSION__;
                        if (!session) return null;
                        const state = session.getState();
                        if (state === 'idle') return null;
                        if (state === 'complete' || state === 'error') return session.serialize();
                        return null;
                    });
                    if (data) {
                        capturedData = data;
                        consoleErrors.push(`[diag] Captured data from frame: ${frame.url()}`);
                        break;
                    }
                } catch { /* frame may be detached */ }
            }

            // Fall back to main frame error reporting if no frame had data
            if (!capturedData) {
                capturedData = await page.evaluate(() => {
                    const w = (globalThis as unknown as { __X_RIPPER_SESSION__?: { serialize(): unknown; getState(): string } });
                    const session = w.__X_RIPPER_SESSION__;
                    if (!session) {
                        throw new Error('WebGL hook was not installed or no WebGL context was created');
                    }
                    const state = session.getState();
                    if (state === 'idle') {
                        throw new Error('No WebGL context was created on this page. Make sure the target URL uses WebGL for rendering.');
                    }
                    if (state !== 'complete' && state !== 'error') {
                        throw new Error(`Capture not finished — session still in state: ${state}. Try increasing the capture duration.`);
                    }
                    return session.serialize();
                });
            }

            // Process the captured data server-side
            const result = await this.processCapture(capturedData as Record<string, unknown>);

            // Attach screenshot and console errors
            result.screenshot = screenshotBase64;
            result.consoleErrors = consoleErrors;

            return result;

        } finally {
            try { await page.close(); } catch { /* page may already be closed */ }
        }
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }

    /**
     * Try to activate 3D viewer elements on known platforms.
     * Many sites (Fab.com, Sketchfab embeds, etc.) only create a WebGL
     * context after user interaction — click the 3D tab/button automatically.
     */
    private async tryActivate3DViewer(page: Page, url: string): Promise<void> {
        try {
            // Fab.com: click the "3D" button/tab in the asset viewer
            if (/fab\.com/i.test(url)) {
                await page.evaluate(() => {
                    // Strategy 1: Look for a button/tab with "3D" text
                    const allButtons = Array.from(document.querySelectorAll('button, [role="tab"], [data-testid*="3d"], [data-testid*="3D"]'));
                    for (const btn of allButtons) {
                        const text = (btn.textContent || '').trim();
                        if (/^3D$/i.test(text) || /3D\s*View/i.test(text)) {
                            (btn as HTMLElement).click();
                            return;
                        }
                    }
                    // Strategy 2: Look for any element with aria-label containing "3D"
                    const ariaBtn = document.querySelector('[aria-label*="3D"], [aria-label*="3d"]');
                    if (ariaBtn) {
                        (ariaBtn as HTMLElement).click();
                        return;
                    }
                    // Strategy 3: Click on the main media/canvas area to trigger lazy load
                    const mediaArea = document.querySelector('[class*="viewer"], [class*="preview"], [class*="media"], canvas');
                    if (mediaArea) {
                        (mediaArea as HTMLElement).click();
                    }
                });
                // Give the 3D viewer time to initialize after click
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            // Sketchfab embeds: click the play button
            if (/sketchfab\.com/i.test(url)) {
                await page.evaluate(() => {
                    const playBtn = document.querySelector('.viewer-start-button, [class*="play"], [aria-label*="Load"]');
                    if (playBtn) (playBtn as HTMLElement).click();
                });
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            // Inject hook into ALL sub-frames via CDP (works for cross-origin with site isolation disabled)
            const hookScript = this.getHookScript({
                captureTextures: true, captureShaders: true,
                captureDuration: 10000, waitForLoad: 0,
                viewport: { width: 0, height: 0 },
            });
            for (const frame of page.frames()) {
                if (frame === page.mainFrame()) continue;
                try {
                    await frame.evaluate(hookScript);
                } catch { /* cross-origin or detached frame — skip */ }
            }

            // Wait for any viewer that just started to render
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Check if any frame has WebGL captures
            const hasCaptures = await this.checkFrameCaptures(page);
            if (hasCaptures) return;

            // Generic: try clicking any visible canvas or interactive 3D element
            await page.evaluate(() => {
                const canvas = document.querySelector('canvas');
                if (canvas) {
                    canvas.click();
                    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }));
                    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 200, clientY: 200 }));
                    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 200, clientY: 200 }));
                }
            });
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch { /* activation is best-effort */ }
    }

    /** Check if any frame (including sub-frames) has WebGL captures */
    private async checkFrameCaptures(page: Page): Promise<boolean> {
        for (const frame of page.frames()) {
            try {
                const state = await frame.evaluate(() => {
                    const w = globalThis as unknown as { __X_RIPPER_SESSION__?: { getState(): string } };
                    return w.__X_RIPPER_SESSION__?.getState() ?? 'not installed';
                });
                if (state === 'complete' || state === 'capturing') return true;
            } catch { /* frame may be detached */ }
        }
        return false;
    }

    /* ---- Hook injection script ---- */

    /**
     * Generates a self-contained IIFE that intercepts all WebGL calls.
     *
     * This inline script includes:
     * - Per-VAO index buffer tracking
     * - Uniform name resolution via getUniformLocation
     * - WebGL1 compatibility (skips VAO for 'webgl' contexts)
     * - Image source texture readback via canvas
     * - SSRF-safe (runs in sandboxed Puppeteer page)
     */
    private getHookScript(options: RipPageOptions): string {
        return `
      (function() {
        'use strict';

        const CONFIG = {
          captureTextures: ${options.captureTextures},
          captureShaders: ${options.captureShaders},
          captureDuration: ${options.captureDuration},
          maxDrawCalls: 10000,
          maxTextures: 512,
          maxTextureBytes: 256 * 1024 * 1024, // 256 MB total texture memory limit
        };

        let state = 'idle';
        let isWebGL2 = false;
        let totalTextureBytes = 0;
        const captured = {
          drawCalls: [],
          buffers: new Map(),
          textures: new Map(),
          shaders: new Map(),
          programs: new Map(),
          vaoAttributes: new Map(),
          vaoIndexBuffers: new Map(),
          uniformNameMap: new Map(),
          currentProgram: 0,
          currentVao: 0,
          currentFramebuffer: null,
          boundBuffers: new Map(),
          activeTextureUnit: 0,
          textureBindings: new Map(),
        };

        let nextId = { buffer: 1, texture: 1, shader: 1, program: 1, vao: 1 };
        const idMaps = {
          buffer: new WeakMap(),
          texture: new WeakMap(),
          shader: new WeakMap(),
          program: new WeakMap(),
          vao: new WeakMap(),
          shaderType: new Map(),
          programShaders: new Map(),
        };

        function getId(type, obj) {
          if (!obj) return 0;
          let id = idMaps[type].get(obj);
          if (!id) { id = nextId[type]++; idMaps[type].set(obj, id); }
          return id;
        }

        function extractImagePixels(source, w, h) {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) { canvas.width = 0; canvas.height = 0; return null; }
            ctx.drawImage(source, 0, 0);
            const imageData = ctx.getImageData(0, 0, w, h);
            const result = uint8ToBase64(new Uint8Array(imageData.data.buffer));
            canvas.width = 0; canvas.height = 0;
            return result;
          } catch(e) { return null; }
        }

        // Base64 encoding — chunked to avoid stack overflow and string concat perf issues
        function uint8ToBase64(bytes) {
          let binary = '';
          const CHUNK = 8192;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          }
          return btoa(binary);
        }

        // Guess glTF semantic name from attribute location
        function guessAttrName(loc) {
          switch (loc) {
            case 0: return 'POSITION';
            case 1: return 'NORMAL';
            case 2: return 'TANGENT';
            case 3: return 'TEXCOORD_0';
            case 4: return 'JOINTS_0';
            case 5: return 'WEIGHTS_0';
            case 6: return 'TEXCOORD_1';
            case 7: return 'COLOR_0';
            default: return 'ATTR_' + loc;
          }
        }

        const originalGetContext = HTMLCanvasElement.prototype.getContext;

        HTMLCanvasElement.prototype.getContext = function(contextId, opts) {
          const ctx = originalGetContext.call(this, contextId, opts);
          if (!ctx || (contextId !== 'webgl2' && contextId !== 'webgl')) return ctx;
          if (state !== 'idle') return ctx;
          state = 'capturing';
          isWebGL2 = (contextId === 'webgl2');
          return wrapGL(ctx);
        };

        function wrapGL(gl) {
          return new Proxy(gl, {
            get(target, prop) {
              const orig = Reflect.get(target, prop);
              if (typeof orig !== 'function') return orig;
              const name = String(prop);

              /* Buffer ops */
              if (name === 'createBuffer') return function() { const b = orig.call(target); if (b) getId('buffer', b); return b; };
              if (name === 'bindBuffer') return function(t, b) {
                const id = getId('buffer', b);
                captured.boundBuffers.set(t, id);
                if (t === 0x8893) {
                  captured.vaoIndexBuffers.set(captured.currentVao, id);
                }
                return orig.call(target, t, b);
              };
              if (name === 'bufferData') return function(t, d, u) {
                orig.call(target, t, d, u);
                const id = captured.boundBuffers.get(t) || 0;
                if (id && d && (d instanceof ArrayBuffer || ArrayBuffer.isView(d))) {
                  const ab = d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
                  const b64 = uint8ToBase64(new Uint8Array(ab));
                  captured.buffers.set(id, { id, target: t, data: b64, usage: u, byteLength: ab.byteLength });
                }
              };
              if (name === 'bufferSubData') return function(t, off, d) {
                orig.call(target, t, off, d);
                const id = captured.boundBuffers.get(t) || 0;
                if (id && d) {
                  const existing = captured.buffers.get(id);
                  if (existing && typeof existing.data === 'string') {
                    const sub = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(0);
                    if (sub.length === 0) return;
                    // Decode existing base64 via atob + fast Uint8Array fill
                    const b64 = atob(existing.data);
                    const decoded = new Uint8Array(b64.length);
                    for (let i = 0; i < b64.length; i++) decoded[i] = b64.charCodeAt(i);
                    // Bounds check: skip if write would exceed buffer
                    if (off + sub.length > decoded.length) return;
                    decoded.set(sub, off);
                    existing.data = uint8ToBase64(decoded);
                  }
                }
              };

              /* Texture ops */
              if (name === 'createTexture') return function() { const t = orig.call(target); if (t) getId('texture', t); return t; };
              if (name === 'activeTexture') return function(u) { captured.activeTextureUnit = u - target.TEXTURE0; return orig.call(target, u); };
              if (name === 'bindTexture') return function(tgt, tex) {
                const id = getId('texture', tex);
                if (!captured.textureBindings.has(captured.activeTextureUnit)) captured.textureBindings.set(captured.activeTextureUnit, new Map());
                captured.textureBindings.get(captured.activeTextureUnit).set(tgt, id);
                return orig.call(target, tgt, tex);
              };
              if (name === 'texImage2D' && CONFIG.captureTextures) return function(...args) {
                orig.apply(target, args);
                if (totalTextureBytes >= CONFIG.maxTextureBytes) return;
                if (args.length >= 9) {
                  const [tgt, lv, iFmt, w, h, , fmt, type, px] = args;
                  const tMap = captured.textureBindings.get(captured.activeTextureUnit);
                  const texId = tMap ? (tMap.get(tgt) || 0) : 0;
                  if (texId && lv === 0 && w > 0 && h > 0) {
                    const pxData = px && ArrayBuffer.isView(px) ? uint8ToBase64(new Uint8Array(px.buffer, px.byteOffset, px.byteLength)) : null;
                    if (pxData) totalTextureBytes += px.byteLength;
                    captured.textures.set(texId, { id: texId, target: tgt, internalFormat: iFmt, width: w, height: h, format: fmt, type, data: pxData, compressed: false });
                  }
                }
                if (args.length === 6) {
                  const [tgt, lv, iFmt, fmt, type, source] = args;
                  const tMap = captured.textureBindings.get(captured.activeTextureUnit);
                  const texId = tMap ? (tMap.get(tgt) || 0) : 0;
                  if (texId && lv === 0 && source && typeof source === 'object') {
                    const w = source.naturalWidth || source.width || source.videoWidth || 0;
                    const h = source.naturalHeight || source.height || source.videoHeight || 0;
                    if (w > 0 && h > 0) {
                      const pxData = extractImagePixels(source, w, h);
                      if (pxData) totalTextureBytes += w * h * 4;
                      captured.textures.set(texId, { id: texId, target: tgt, internalFormat: iFmt, width: w, height: h, format: 0x1908, type, data: pxData, compressed: false });
                    }
                  }
                }
              };
              if (name === 'compressedTexImage2D' && CONFIG.captureTextures) return function(...args) {
                orig.apply(target, args);
                if (totalTextureBytes >= CONFIG.maxTextureBytes) return;
                if (args.length >= 7) {
                  const [tgt, lv, iFmt, w, h, , data] = args;
                  const tMap = captured.textureBindings.get(captured.activeTextureUnit);
                  const texId = tMap ? (tMap.get(tgt) || 0) : 0;
                  if (texId && lv === 0 && w > 0 && h > 0) {
                    const pxData = ArrayBuffer.isView(data) ? uint8ToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) : null;
                    if (pxData && ArrayBuffer.isView(data)) totalTextureBytes += data.byteLength;
                    captured.textures.set(texId, { id: texId, target: tgt, internalFormat: iFmt, width: w, height: h, format: iFmt, type: 0, data: pxData, compressed: true });
                  }
                }
              };

              /* texSubImage2D — partial texture updates */
              if (name === 'texSubImage2D' && CONFIG.captureTextures) return function(...args) {
                orig.apply(target, args);
                // Only track if we don't already have data for this texture
                // (sub-updates are patches; we rely on the initial texImage2D for base data)
              };

              /* texStorage2D — allocates immutable storage (WebGL2) */
              if (name === 'texStorage2D' && CONFIG.captureTextures) return function(tgt, levels, iFmt, w, h) {
                orig.call(target, tgt, levels, iFmt, w, h);
                const tMap = captured.textureBindings.get(captured.activeTextureUnit);
                const texId = tMap ? (tMap.get(tgt) || 0) : 0;
                if (texId && w > 0 && h > 0) {
                  // Storage allocated but no data yet — record metadata
                  if (!captured.textures.has(texId)) {
                    captured.textures.set(texId, { id: texId, target: tgt, internalFormat: iFmt, width: w, height: h, format: iFmt, type: 0, data: null, compressed: false });
                  }
                }
              };

              /* Shader / program ops */
              if (name === 'createShader') return function(type) { const s = orig.call(target, type); if (s) { const id = getId('shader', s); idMaps.shaderType.set(id, type); } return s; };
              if (name === 'shaderSource' && CONFIG.captureShaders) return function(s, src) { const id = getId('shader', s); const type = idMaps.shaderType.get(id) || 0; captured.shaders.set(id, { id, type, source: src }); return orig.call(target, s, src); };
              if (name === 'createProgram') return function() { const p = orig.call(target); if (p) getId('program', p); return p; };
              if (name === 'attachShader') return function(p, s) { const pid = getId('program', p); const sid = getId('shader', s); const type = idMaps.shaderType.get(sid) || 0; const ex = idMaps.programShaders.get(pid) || [0,0]; if (type === target.VERTEX_SHADER) ex[0] = sid; else ex[1] = sid; idMaps.programShaders.set(pid, ex); return orig.call(target, p, s); };
              if (name === 'linkProgram') return function(p) { const pid = getId('program', p); const [vs, fs] = idMaps.programShaders.get(pid) || [0,0]; captured.programs.set(pid, { id: pid, vsId: vs, fsId: fs }); return orig.call(target, p); };
              if (name === 'useProgram') return function(p) { captured.currentProgram = p ? getId('program', p) : 0; return orig.call(target, p); };

              /* Uniform name tracking */
              if (name === 'getUniformLocation') return function(p, uName) {
                const loc = orig.call(target, p, uName);
                if (loc) captured.uniformNameMap.set(loc, uName);
                return loc;
              };

              /* Uniform value ops — capture values for material property extraction */
              if (name.startsWith('uniform') && !name.includes('Block')) return function(...args) {
                orig.apply(target, args);
                const loc = args[0];
                if (!loc) return;
                const uName = captured.uniformNameMap.get(loc) || ('unknown_' + name);
                const val = args.length === 2 ? args[1] : Array.from(args.slice(1));
                if (!captured.uniformValues) captured.uniformValues = new Map();
                if (!captured.uniformValues.has(captured.currentProgram)) captured.uniformValues.set(captured.currentProgram, {});
                captured.uniformValues.get(captured.currentProgram)[uName] = val;
              };

              /* VAO ops - WebGL2 only */
              if (name === 'createVertexArray') {
                if (!isWebGL2) return orig.bind(target);
                return function() { const v = orig.call(target); if (v) getId('vao', v); return v; };
              }
              if (name === 'bindVertexArray') {
                if (!isWebGL2) return orig.bind(target);
                return function(v) { captured.currentVao = v ? getId('vao', v) : 0; return orig.call(target, v); };
              }
              if (name === 'vertexAttribPointer') return function(loc, size, type, norm, stride, offset) {
                if (!captured.vaoAttributes.has(captured.currentVao)) captured.vaoAttributes.set(captured.currentVao, []);
                const attrs = captured.vaoAttributes.get(captured.currentVao);
                const buffId = captured.boundBuffers.get(0x8892) || 0;
                const idx = attrs.findIndex(a => a.location === loc);
                const attr = { location: loc, name: guessAttrName(loc), size, type, normalized: norm, stride, offset, bufferId: buffId };
                if (idx >= 0) attrs[idx] = attr; else attrs.push(attr);
                return orig.call(target, loc, size, type, norm, stride, offset);
              };

              /* Framebuffer ops — track per-object IDs for off-screen pass filtering */
              if (name === 'createFramebuffer') return function() {
                const fb = orig.call(target);
                if (fb) { if (!captured._nextFbId) captured._nextFbId = 1; captured._fbIds = captured._fbIds || new WeakMap(); captured._fbIds.set(fb, captured._nextFbId++); }
                return fb;
              };
              if (name === 'bindFramebuffer') return function(t, fb) {
                captured.currentFramebuffer = fb ? ((captured._fbIds && captured._fbIds.get(fb)) || 1) : null;
                return orig.call(target, t, fb);
              };

              /* Draw calls — includes drawRangeElements */
              if (name === 'drawArrays' || name === 'drawElements' || name === 'drawArraysInstanced' || name === 'drawElementsInstanced' || name === 'drawRangeElements') {
                return function(...args) {
                  orig.apply(target, args);
                  if (captured.drawCalls.length >= CONFIG.maxDrawCalls) return;
                  // Build texture bindings with sampler uniform names
                  const bindings = [];
                  const progUniforms = captured.uniformValues && captured.uniformValues.get(captured.currentProgram);
                  for (const [unit, targets] of captured.textureBindings) {
                    for (const [tgt, texId] of targets) {
                      if (texId > 0) {
                        // Find sampler uniform bound to this texture unit
                        let samplerName = '';
                        if (progUniforms) {
                          for (const [uName, uVal] of Object.entries(progUniforms)) {
                            if (uVal === unit) { samplerName = uName; break; }
                          }
                        }
                        bindings.push({ unit, target: tgt, textureId: texId, samplerUniform: samplerName });
                      }
                    }
                  }
                  // Extract indexType from drawElements-style calls
                  let indexType = 0;
                  if (name === 'drawElements') indexType = args[2] || 0;
                  else if (name === 'drawElementsInstanced') indexType = args[2] || 0;
                  else if (name === 'drawRangeElements') indexType = args[4] || 0;

                  captured.drawCalls.push({
                    index: captured.drawCalls.length,
                    type: name,
                    args: Array.from(args),
                    programId: captured.currentProgram,
                    vaoId: captured.currentVao,
                    framebufferId: captured.currentFramebuffer,
                    textureBindings: bindings,
                    indexType: indexType,
                  });
                };
              }

              return orig.bind(target);
            }
          });
        }

        // Auto-complete after capture duration
        setTimeout(() => {
          state = 'complete';
          HTMLCanvasElement.prototype.getContext = originalGetContext;
        }, CONFIG.captureDuration);

        // Expose session object for extraction
        window.__X_RIPPER_SESSION__ = {
          getState() { return state; },
          serialize() {
            return {
              stats: {
                drawCallCount: captured.drawCalls.length,
                bufferCount: captured.buffers.size,
                textureCount: captured.textures.size,
                shaderCount: captured.shaders.size,
                programCount: captured.programs.size,
              },
              drawCalls: captured.drawCalls,
              buffers: Array.from(captured.buffers.values()),
              textures: Array.from(captured.textures.values()),
              shaders: Array.from(captured.shaders.values()),
              programs: Array.from(captured.programs.values()),
              vaoAttributes: Array.from(captured.vaoAttributes.entries()),
              vaoIndexBuffers: Array.from(captured.vaoIndexBuffers.entries()),
            };
          },
        };
      })();
    `;
    }

    /* ---- Server-side processing ---- */

    private async processCapture(data: Record<string, unknown>): Promise<RipPageResult> {
        const stats = data.stats as Record<string, number>;

        // Build a minimal GLB from captured data
        const glb = this.buildMinimalGLB(data);

        // Build a RipScene for format-specific exporters (UAsset, OBJ)
        const scene = this.buildRipScene(data);

        const meshCount = scene.meshes.length;

        return {
            glb,
            scene,
            stats: {
                meshCount,
                textureCount: stats.textureCount ?? 0,
                shaderCount: stats.shaderCount ?? 0,
                drawCallCount: stats.drawCallCount ?? 0,
                captureTimeMs: stats.captureTimeMs ?? 0,
            },
        };
    }

    /**
     * Build a RipScene from raw captured data.
     * Extracts per-VAO primitives with positions, normals, UVs, indices,
     * plus textures and materials. Used by UAssetExporter and OBJExporter.
     */
    private buildRipScene(data: Record<string, unknown>): RipScene {
        const rawBuffers = (data.buffers as unknown[]) ?? [];
        const rawTextures = (data.textures as unknown[]) ?? [];
        const rawDrawCalls = (data.drawCalls as unknown[]) ?? [];
        const rawVaoAttributes = (data.vaoAttributes as unknown[]) ?? [];
        const rawVaoIndexBuffers = (data.vaoIndexBuffers as unknown[]) ?? [];
        const rawShaders = (data.shaders as unknown[]) ?? [];
        const stats = data.stats as Record<string, number>;

        // Decode buffer data
        const bufferMap = new Map<number, Uint8Array>();
        for (const buf of rawBuffers) {
            const b = buf as { id: number; target: number; data: string | null; byteLength: number };
            if (!b.data) continue;
            bufferMap.set(b.id, this.base64ToUint8(b.data));
        }

        // Build VAO lookup maps
        const vaoAttrsMap = new Map<number, { location: number; name?: string; size: number; type: number; stride: number; offset: number; bufferId: number }[]>();
        for (const entry of rawVaoAttributes) {
            const [vaoId, attrs] = entry as [number, unknown[]];
            vaoAttrsMap.set(vaoId, attrs as typeof vaoAttrsMap extends Map<number, infer V> ? V : never);
        }
        const vaoIndexMap = new Map<number, number>();
        for (const entry of rawVaoIndexBuffers) {
            const [vaoId, bufferId] = entry as [number, number];
            vaoIndexMap.set(vaoId, bufferId);
        }

        // Group draw calls by VAO (only on-screen)
        const vaoDrawCalls = new Map<number, unknown[]>();
        for (const dc of rawDrawCalls) {
            const d = dc as { vaoId: number; framebufferId: number | null };
            if (d.framebufferId !== null) continue;
            if (!vaoDrawCalls.has(d.vaoId)) vaoDrawCalls.set(d.vaoId, []);
            vaoDrawCalls.get(d.vaoId)!.push(dc);
        }

        // Build meshes from VAO groups
        const meshes: RipMesh[] = [];
        const materials: RipMaterial[] = [{
            name: 'Default',
            programId: 0,
            baseColor: [0.8, 0.8, 0.8, 1.0],
            metallic: 0.0,
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
        }];

        let meshIdx = 0;
        for (const [vaoId, _calls] of vaoDrawCalls) {
            const attrs = vaoAttrsMap.get(vaoId) ?? [];
            if (attrs.length === 0) continue;

            const posAttr = attrs.find(a => a.name === 'POSITION') ?? attrs.find(a => a.location === 0);
            if (!posAttr) continue;

            const posBuffer = bufferMap.get(posAttr.bufferId);
            if (!posBuffer) continue;

            const posStride = posAttr.stride || (posAttr.size * 4);
            if (posAttr.offset >= posBuffer.byteLength) continue;
            const vertexCount = Math.floor((posBuffer.byteLength - posAttr.offset) / posStride);
            if (vertexCount <= 0) continue;

            // Extract positions
            const positions = new Float32Array(vertexCount * 3);
            const posFloats = new Float32Array(posBuffer.buffer, posBuffer.byteOffset, Math.floor(posBuffer.byteLength / 4));
            const posStride4 = posStride / 4;
            const posOff4 = posAttr.offset / 4;
            for (let i = 0; i < vertexCount; i++) {
                const base = posOff4 + i * posStride4;
                if (base + 2 >= posFloats.length) break;
                positions[i * 3] = posFloats[base];
                positions[i * 3 + 1] = posFloats[base + 1];
                positions[i * 3 + 2] = posFloats[base + 2];
            }

            // Extract normals
            const normAttr = attrs.find(a => a.name === 'NORMAL') ?? attrs.find(a => a.location === 1);
            let normals: Float32Array | null = null;
            if (normAttr) {
                const normBuf = bufferMap.get(normAttr.bufferId);
                if (normBuf) {
                    normals = new Float32Array(vertexCount * 3);
                    const normFloats = new Float32Array(normBuf.buffer, normBuf.byteOffset, Math.floor(normBuf.byteLength / 4));
                    const normStride4 = (normAttr.stride || (normAttr.size * 4)) / 4;
                    const normOff4 = normAttr.offset / 4;
                    for (let i = 0; i < vertexCount; i++) {
                        const base = normOff4 + i * normStride4;
                        if (base + 2 >= normFloats.length) break;
                        normals[i * 3] = normFloats[base];
                        normals[i * 3 + 1] = normFloats[base + 1];
                        normals[i * 3 + 2] = normFloats[base + 2];
                    }
                }
            }

            // Extract UVs
            const uvAttr = attrs.find(a => a.name === 'TEXCOORD_0') ?? attrs.find(a => a.location === 3);
            let uvs: Float32Array | null = null;
            if (uvAttr) {
                const uvBuf = bufferMap.get(uvAttr.bufferId);
                if (uvBuf) {
                    uvs = new Float32Array(vertexCount * 2);
                    const uvFloats = new Float32Array(uvBuf.buffer, uvBuf.byteOffset, Math.floor(uvBuf.byteLength / 4));
                    const uvStride4 = (uvAttr.stride || (uvAttr.size * 4)) / 4;
                    const uvOff4 = uvAttr.offset / 4;
                    for (let i = 0; i < vertexCount; i++) {
                        const base = uvOff4 + i * uvStride4;
                        if (base + 1 >= uvFloats.length) break;
                        uvs[i * 2] = uvFloats[base];
                        uvs[i * 2 + 1] = uvFloats[base + 1];
                    }
                }
            }

            // Extract tangents
            const tanAttr = attrs.find(a => a.name === 'TANGENT') ?? attrs.find(a => a.location === 2);
            let tangents: Float32Array | null = null;
            if (tanAttr && tanAttr.size === 4) {
                const tanBuf = bufferMap.get(tanAttr.bufferId);
                if (tanBuf) {
                    tangents = new Float32Array(vertexCount * 4);
                    const tanFloats = new Float32Array(tanBuf.buffer, tanBuf.byteOffset, Math.floor(tanBuf.byteLength / 4));
                    const tanStride4 = (tanAttr.stride || (tanAttr.size * 4)) / 4;
                    const tanOff4 = tanAttr.offset / 4;
                    for (let i = 0; i < vertexCount; i++) {
                        const base = tanOff4 + i * tanStride4;
                        if (base + 3 >= tanFloats.length) break;
                        tangents[i * 4] = tanFloats[base];
                        tangents[i * 4 + 1] = tanFloats[base + 1];
                        tangents[i * 4 + 2] = tanFloats[base + 2];
                        tangents[i * 4 + 3] = tanFloats[base + 3];
                    }
                }
            }

            // Extract colors
            const colAttr = attrs.find(a => a.name === 'COLOR_0') ?? attrs.find(a => a.location === 7);
            let colors: Float32Array | null = null;
            if (colAttr) {
                const colBuf = bufferMap.get(colAttr.bufferId);
                if (colBuf) {
                    colors = new Float32Array(vertexCount * 4);
                    const colFloats = new Float32Array(colBuf.buffer, colBuf.byteOffset, Math.floor(colBuf.byteLength / 4));
                    const colStride4 = (colAttr.stride || (colAttr.size * 4)) / 4;
                    const colOff4 = colAttr.offset / 4;
                    for (let i = 0; i < vertexCount; i++) {
                        const base = colOff4 + i * colStride4;
                        if (base + colAttr.size - 1 >= colFloats.length) break;
                        colors[i * 4] = colFloats[base];
                        colors[i * 4 + 1] = colAttr.size >= 2 ? colFloats[base + 1] : 0;
                        colors[i * 4 + 2] = colAttr.size >= 3 ? colFloats[base + 2] : 0;
                        colors[i * 4 + 3] = colAttr.size >= 4 ? colFloats[base + 3] : 1;
                    }
                }
            }

            // Extract indices
            const hasIndexedDraw = _calls.some((c: unknown) => {
                const t = (c as { type?: string }).type ?? '';
                return t.includes('Elements');
            });
            let indices: Uint16Array | Uint32Array | null = null;
            if (hasIndexedDraw) {
                const indexBufferId = vaoIndexMap.get(vaoId);
                if (indexBufferId !== undefined) {
                    const idxBuf = bufferMap.get(indexBufferId);
                    if (idxBuf) {
                        const firstDc = _calls[0] as { indexType?: number };
                        const idxType = firstDc?.indexType || 0x1403;
                        if (idxType === 0x1405) { // UNSIGNED_INT
                            indices = new Uint32Array(idxBuf.buffer, idxBuf.byteOffset, Math.floor(idxBuf.byteLength / 4));
                        } else if (idxType === 0x1401) { // UNSIGNED_BYTE
                            const promoted = new Uint16Array(idxBuf.byteLength);
                            for (let i = 0; i < idxBuf.byteLength; i++) promoted[i] = idxBuf[i];
                            indices = promoted;
                        } else { // UNSIGNED_SHORT
                            indices = new Uint16Array(idxBuf.buffer, idxBuf.byteOffset, Math.floor(idxBuf.byteLength / 2));
                        }
                    }
                }
            }

            const primitive: RipPrimitive = {
                positions,
                normals,
                tangents,
                uvs,
                uvs2: null,
                colors,
                jointIndices: null,
                jointWeights: null,
                indices,
                materialIndex: 0,
                mode: 4, // TRIANGLES
                vertexCount,
            };

            meshes.push({
                name: `Mesh_${meshIdx}`,
                primitives: [primitive],
            });
            meshIdx++;
        }

        // Build textures
        const textures: RipTexture[] = [];
        for (const tex of rawTextures) {
            const t = tex as { id: number; width: number; height: number; data: string | null; compressed: boolean };
            if (!t.data) continue;
            const texData = this.base64ToUint8(t.data);
            textures.push({
                name: `Texture_${t.id}`,
                width: t.width,
                height: t.height,
                data: texData.buffer.slice(texData.byteOffset, texData.byteOffset + texData.byteLength),
                format: 'rgba',
                compressed: t.compressed || false,
                mimeType: 'image/png',
            });
        }

        // Assign first texture as albedo on default material
        if (textures.length > 0) {
            materials[0].albedoTextureIndex = 0;
        }

        // Build nodes (one per mesh)
        const nodes: RipNode[] = meshes.map((_, i) => ({
            name: `Node_${i}`,
            meshIndex: i,
            children: [],
            translation: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0, 1] as [number, number, number, number],
            scale: [1, 1, 1] as [number, number, number],
        }));

        const scene: RipScene = {
            name: 'Ripped Scene',
            nodes,
            meshes,
            materials,
            textures,
            metadata: {
                sourceUrl: '',
                capturedAt: new Date().toISOString(),
                totalDrawCalls: stats.drawCallCount ?? 0,
                totalBuffers: stats.bufferCount ?? 0,
                totalTextures: stats.textureCount ?? 0,
                totalShaders: stats.shaderCount ?? 0,
                captureTimeMs: stats.captureTimeMs ?? 0,
                rendererInfo: 'headless-chrome',
                canvasSize: [1920, 1080],
            },
        };

        return scene;
    }

    /**
     * Build a minimal GLB file from the captured data.
     * This is a simplified server-side reconstruction.
     */
    private buildMinimalGLB(data: Record<string, unknown>): ArrayBuffer {
        const buffers = (data.buffers as unknown[]) ?? [];
        const textures = (data.textures as unknown[]) ?? [];
        const drawCalls = (data.drawCalls as unknown[]) ?? [];
        const vaoAttributes = (data.vaoAttributes as unknown[]) ?? [];
        const vaoIndexBuffers = (data.vaoIndexBuffers as unknown[]) ?? [];

        // Reconstruct buffer data from Base64-encoded strings
        const vertexBuffers = new Map<number, Uint8Array>();
        for (const buf of buffers) {
            const b = buf as { id: number; target: number; data: string | null; byteLength: number };
            if (!b.data) continue; // skip buffers that were allocated but never received data
            vertexBuffers.set(b.id, this.base64ToUint8(b.data));
        }

        // Build glTF JSON
        const gltf: Record<string, unknown> = {
            asset: { version: '2.0', generator: 'DemonZ Ripper PageLoader' },
            scene: 0,
            scenes: [{ name: 'Ripped Scene', nodes: [] as number[] }],
            nodes: [] as unknown[],
            meshes: [] as unknown[],
            accessors: [] as unknown[],
            bufferViews: [] as unknown[],
            buffers: [] as unknown[],
            materials: [{
                name: 'Default',
                pbrMetallicRoughness: {
                    baseColorFactor: [0.8, 0.8, 0.8, 1.0],
                    metallicFactor: 0.0,
                    roughnessFactor: 0.5,
                },
            }],
        };

        // Collect all buffer data into a single binary blob
        const binaryChunks: Uint8Array[] = [];
        let currentOffset = 0;

        // Process each VAO group of draw calls that target the screen
        const sceneNodes = gltf.scenes as { name: string; nodes: number[] }[];
        const nodesArr = gltf.nodes as unknown[];
        const meshesArr = gltf.meshes as unknown[];
        const accessorsArr = gltf.accessors as unknown[];
        const bufferViewsArr = gltf.bufferViews as unknown[];

        // Group draw calls by VAO
        const vaoDrawCalls = new Map<number, unknown[]>();
        for (const dc of drawCalls) {
            const d = dc as { vaoId: number; framebufferId: number | null };
            if (d.framebufferId !== null) continue; // skip off-screen
            if (!vaoDrawCalls.has(d.vaoId)) vaoDrawCalls.set(d.vaoId, []);
            vaoDrawCalls.get(d.vaoId)!.push(dc);
        }

        // Build vao attribute lookup
        const vaoAttrsMap = new Map<number, unknown[]>();
        for (const entry of vaoAttributes) {
            const [vaoId, attrs] = entry as [number, unknown[]];
            vaoAttrsMap.set(vaoId, attrs);
        }

        // Build vao index buffer lookup
        const vaoIndexMap = new Map<number, number>();
        for (const entry of vaoIndexBuffers) {
            const [vaoId, bufferId] = entry as [number, number];
            vaoIndexMap.set(vaoId, bufferId);
        }

        let meshIndex = 0;
        for (const [vaoId, calls] of vaoDrawCalls) {
            const attrs = (vaoAttrsMap.get(vaoId) ?? []) as {
                location: number; name?: string; size: number; type: number;
                stride: number; offset: number; bufferId: number;
            }[];
            if (attrs.length === 0) continue;

            // Find position attribute by name (fallback to location 0)
            const posAttr = attrs.find(a => a.name === 'POSITION') ?? attrs.find(a => a.location === 0);
            if (!posAttr) continue;

            const posBuffer = vertexBuffers.get(posAttr.bufferId);
            if (!posBuffer) continue;

            // Detect interleaving: group attributes that share the same buffer
            const bufferGroups = new Map<number, typeof attrs>();
            for (const attr of attrs) {
                if (!bufferGroups.has(attr.bufferId)) bufferGroups.set(attr.bufferId, []);
                bufferGroups.get(attr.bufferId)!.push(attr);
            }

            // Emit one bufferView per unique buffer, with byteStride if interleaved
            const bufferViewForBuffer = new Map<number, number>();
            for (const [bufferId, groupAttrs] of bufferGroups) {
                const buf = vertexBuffers.get(bufferId);
                if (!buf) continue;

                const viewIndex = bufferViewsArr.length;
                bufferViewForBuffer.set(bufferId, viewIndex);

                const padding = (4 - (buf.byteLength % 4)) % 4;
                const paddedBuf = new Uint8Array(buf.byteLength + padding);
                paddedBuf.set(buf);
                binaryChunks.push(paddedBuf);

                const bv: Record<string, unknown> = {
                    buffer: 0,
                    byteOffset: currentOffset,
                    byteLength: buf.byteLength,
                    target: 34962,
                };

                // Add byteStride if multiple attributes share this buffer (interleaved)
                if (groupAttrs.length > 1 && groupAttrs[0].stride > 0) {
                    bv.byteStride = groupAttrs[0].stride;
                }

                bufferViewsArr.push(bv);
                currentOffset += paddedBuf.byteLength;
            }

            // Compute vertex count from position buffer
            const posStride = posAttr.stride || (posAttr.size * 4);
            if (posAttr.offset >= posBuffer.byteLength) continue; // offset beyond buffer
            const vertexCount = Math.floor((posBuffer.byteLength - posAttr.offset) / posStride);
            if (vertexCount <= 0) continue; // no vertices extractable

            // Build accessors for each attribute
            const primitive: Record<string, unknown> = {
                attributes: {} as Record<string, number>,
                material: 0,
                mode: 4, // TRIANGLES
            };
            const primAttrs = primitive.attributes as Record<string, number>;

            // Map of semantic → accessor configs
            const semanticMap: [string, typeof attrs[0] | undefined][] = [
                ['POSITION', posAttr],
                ['NORMAL', attrs.find(a => a.name === 'NORMAL') ?? attrs.find(a => a.location === 1)],
                ['TANGENT', attrs.find(a => a.name === 'TANGENT') ?? attrs.find(a => a.location === 2)],
                ['TEXCOORD_0', attrs.find(a => a.name === 'TEXCOORD_0') ?? attrs.find(a => a.location === 3)],
                ['TEXCOORD_1', attrs.find(a => a.name === 'TEXCOORD_1') ?? attrs.find(a => a.location === 6)],
                ['COLOR_0', attrs.find(a => a.name === 'COLOR_0') ?? attrs.find(a => a.location === 7)],
                ['JOINTS_0', attrs.find(a => a.name === 'JOINTS_0') ?? attrs.find(a => a.location === 4)],
                ['WEIGHTS_0', attrs.find(a => a.name === 'WEIGHTS_0') ?? attrs.find(a => a.location === 5)],
            ];

            for (const [semantic, attr] of semanticMap) {
                if (!attr) continue;
                const viewIdx = bufferViewForBuffer.get(attr.bufferId);
                if (viewIdx === undefined) continue;

                const attrBuf = vertexBuffers.get(attr.bufferId)!;
                const attrStride = attr.stride || (attr.size * 4);
                const attrVtxCount = attr === posAttr ? vertexCount
                    : (attr.offset >= attrBuf.byteLength ? 0 : Math.floor((attrBuf.byteLength - attr.offset) / attrStride));
                if (attrVtxCount <= 0) continue; // skip attributes with no extractable data

                const accessorIdx = accessorsArr.length;
                const accessor: Record<string, unknown> = {
                    bufferView: viewIdx,
                    byteOffset: attr.offset,
                    componentType: 5126, // FLOAT
                    count: Math.min(attrVtxCount, vertexCount),
                    type: attr.size === 4 ? 'VEC4' : attr.size === 3 ? 'VEC3' : attr.size === 2 ? 'VEC2' : 'SCALAR',
                };

                // Compute min/max for POSITION
                if (semantic === 'POSITION') {
                    const posFloats = new Float32Array(posBuffer.buffer, posBuffer.byteOffset, Math.floor(posBuffer.byteLength / 4));
                    const stride4 = posStride / 4; // stride in float elements
                    const offset4 = attr.offset / 4;
                    const min = new Array(attr.size).fill(Infinity);
                    const max = new Array(attr.size).fill(-Infinity);
                    for (let i = 0; i < vertexCount; i++) {
                        const baseIdx = offset4 + i * stride4;
                        if (baseIdx + attr.size > posFloats.length) break;
                        for (let c = 0; c < attr.size; c++) {
                            const val = posFloats[baseIdx + c];
                            if (val < min[c]) min[c] = val;
                            if (val > max[c]) max[c] = val;
                        }
                    }
                    if (min.every(v => Number.isFinite(v)) && max.every(v => Number.isFinite(v))) {
                        accessor.min = min;
                        accessor.max = max;
                    }
                }

                accessorsArr.push(accessor);
                primAttrs[semantic] = accessorIdx;
            }

            // Add index buffer if available for this VAO AND draw calls are indexed
            const hasIndexedDraw = calls.some((c: unknown) => {
                const t = (c as { type?: string }).type ?? '';
                return t.includes('Elements');
            });
            const indexBufferId = hasIndexedDraw ? vaoIndexMap.get(vaoId) : undefined;
            if (indexBufferId) {
                const indexBuffer = vertexBuffers.get(indexBufferId);
                if (indexBuffer) {
                    // Determine index type from first draw call in this VAO
                    const firstDc = calls[0] as { indexType?: number; type?: string };
                    const idxType = firstDc?.indexType || 0x1403; // default UNSIGNED_SHORT
                    const componentType = idxType === 0x1405 ? 5125 : 5123; // glTF only supports SHORT/INT

                    // UNSIGNED_BYTE (0x1401): repack into Uint16Array for glTF compat
                    // (glTF does not support UNSIGNED_BYTE indices)
                    let idxData: Uint8Array;
                    let idxByteLength: number;
                    let idxCount: number;

                    if (idxType === 0x1401 /* UNSIGNED_BYTE */) {
                        idxCount = indexBuffer.byteLength;
                        const promoted = new Uint16Array(idxCount);
                        for (let i = 0; i < idxCount; i++) promoted[i] = indexBuffer[i];
                        const promotedBytes = new Uint8Array(promoted.buffer);
                        idxByteLength = promotedBytes.byteLength;
                        const idxPadding = (4 - (idxByteLength % 4)) % 4;
                        idxData = new Uint8Array(idxByteLength + idxPadding);
                        idxData.set(promotedBytes);
                    } else {
                        const bytesPerIndex = idxType === 0x1405 ? 4 : 2;
                        idxCount = Math.floor(indexBuffer.byteLength / bytesPerIndex);
                        idxByteLength = indexBuffer.byteLength;
                        const idxPadding = (4 - (idxByteLength % 4)) % 4;
                        idxData = new Uint8Array(idxByteLength + idxPadding);
                        idxData.set(indexBuffer);
                    }

                    if (idxCount > 0) {
                        const idxViewIndex = bufferViewsArr.length;
                        binaryChunks.push(idxData);

                        bufferViewsArr.push({
                            buffer: 0,
                            byteOffset: currentOffset,
                            byteLength: idxByteLength,
                            target: 34963,
                        });
                        currentOffset += idxData.byteLength;

                        const idxAccessorIndex = accessorsArr.length;
                        accessorsArr.push({
                            bufferView: idxViewIndex,
                            byteOffset: 0,
                            componentType,
                            count: idxCount,
                            type: 'SCALAR',
                        });
                        primitive.indices = idxAccessorIndex;
                    }
                }
            }

            meshesArr.push({
                name: 'Mesh_' + meshIndex,
                primitives: [primitive],
            });

            sceneNodes[0].nodes.push(nodesArr.length);
            nodesArr.push({
                name: 'Node_' + meshIndex,
                mesh: meshIndex,
            });

            meshIndex++;
        }

        // Embed captured textures into the GLB as images
        if (textures.length > 0) {
            const gltfTextures: unknown[] = [];
            const gltfImages: unknown[] = [];
            const gltfSamplers: unknown[] = [{
                magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497,
            }];

            for (const tex of textures) {
                const t = tex as { id: number; width: number; height: number; data: string | null; compressed: boolean };
                if (!t.data) continue;

                const texBytes = this.base64ToUint8(t.data);
                const padding = (4 - (texBytes.byteLength % 4)) % 4;
                const padded = new Uint8Array(texBytes.byteLength + padding);
                padded.set(texBytes);

                const bvIndex = bufferViewsArr.length;
                bufferViewsArr.push({
                    buffer: 0,
                    byteOffset: currentOffset,
                    byteLength: texBytes.byteLength,
                });
                binaryChunks.push(padded);
                currentOffset += padded.byteLength;

                const imgIndex = gltfImages.length;
                gltfImages.push({ bufferView: bvIndex, mimeType: 'image/png' });
                gltfTextures.push({ source: imgIndex, sampler: 0 });
            }

            if (gltfImages.length > 0) {
                (gltf as Record<string, unknown>).textures = gltfTextures;
                (gltf as Record<string, unknown>).images = gltfImages;
                (gltf as Record<string, unknown>).samplers = gltfSamplers;

                // Assign first texture as baseColorTexture on the default material
                const mats = gltf.materials as Record<string, unknown>[];
                if (mats[0]) {
                    const pbr = (mats[0] as Record<string, unknown>).pbrMetallicRoughness as Record<string, unknown>;
                    pbr.baseColorTexture = { index: 0 };
                }
            }
        }

        // Finalize buffer
        let totalBinaryLength = 0;
        for (const chunk of binaryChunks) totalBinaryLength += chunk.byteLength;

        const totalBinary = new Uint8Array(totalBinaryLength);
        let off = 0;
        for (const chunk of binaryChunks) {
            totalBinary.set(chunk, off);
            off += chunk.byteLength;
        }

        (gltf.buffers as unknown[]).push({ byteLength: totalBinaryLength });

        // Pack GLB
        const jsonStr = JSON.stringify(gltf);
        const jsonBytes = new TextEncoder().encode(jsonStr);
        const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
        const jsonChunkLen = jsonBytes.byteLength + jsonPadding;
        const binPadding = (4 - (totalBinaryLength % 4)) % 4;
        const binChunkLen = totalBinaryLength + binPadding;
        const totalLength = 12 + 8 + jsonChunkLen + 8 + binChunkLen;

        const glb = new ArrayBuffer(totalLength);
        const view = new DataView(glb);
        const bytes = new Uint8Array(glb);

        view.setUint32(0, 0x46546C67, true);  // glTF
        view.setUint32(4, 2, true);            // version
        view.setUint32(8, totalLength, true);

        view.setUint32(12, jsonChunkLen, true);
        view.setUint32(16, 0x4E4F534A, true);  // JSON
        bytes.set(jsonBytes, 20);
        for (let i = 0; i < jsonPadding; i++) bytes[20 + jsonBytes.byteLength + i] = 0x20;

        const binOff = 20 + jsonChunkLen;
        view.setUint32(binOff, binChunkLen, true);
        view.setUint32(binOff + 4, 0x004E4942, true);  // BIN\0
        bytes.set(totalBinary, binOff + 8);

        return glb;
    }

    /** Decode a Base64 string back to Uint8Array (always aligned at offset 0) */
    private base64ToUint8(b64: string): Uint8Array {
        if (!b64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
            throw new Error('Invalid base64 encoding');
        }
        const binary = Buffer.from(b64, 'base64');
        if (binary.length > 256 * 1024 * 1024) {
            throw new Error('Decoded buffer exceeds 256 MB limit');
        }
        // Copy into a fresh ArrayBuffer to guarantee byteOffset=0 and 4-byte alignment,
        // which avoids RangeError when constructing Float32Array views later.
        const aligned = new Uint8Array(binary.length);
        aligned.set(binary);
        return aligned;
    }
}
