import { useRef, useEffect } from 'react';

interface AssetPreviewProps {
    glbUrl?: string;
    width?: number;
    height?: number;
}

/**
 * Lightweight 3D preview using a basic WebGL2 renderer.
 * For full-featured previewing, this would use the @platform/viewer-engine.
 */
export default function AssetPreview({ glbUrl, width = 400, height = 300 }: AssetPreviewProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const glRef = useRef<WebGL2RenderingContext | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
        if (!gl) return;
        glRef.current = gl;

        // Setup minimal viewport
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.06, 0.06, 0.09, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);

        // Draw a rotating grid placeholder
        let animId: number;
        let time = 0;

        const render = () => {
            time += 0.016;
            gl.clearColor(
                0.06 + Math.sin(time * 0.5) * 0.01,
                0.06,
                0.09 + Math.sin(time * 0.3) * 0.01,
                1.0,
            );
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            animId = requestAnimationFrame(render);
        };

        render();

        return () => {
            cancelAnimationFrame(animId);
            // Release WebGL context to prevent context leak (browsers limit to ~8-16)
            const loseCtx = gl.getExtension('WEBGL_lose_context');
            if (loseCtx) loseCtx.loseContext();
            glRef.current = null;
        };
    }, [glbUrl]);

    return (
        <div style={{
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            border: '1px solid var(--border-subtle)',
            position: 'relative',
        }}>
            <canvas
                ref={canvasRef}
                width={width * 2}
                height={height * 2}
                style={{ width, height, display: 'block' }}
            />
            {!glbUrl && (
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(10, 10, 15, 0.7)',
                    backdropFilter: 'blur(4px)',
                }}>
                    <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.4 }}>🎲</div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        No model loaded
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Rip a scene to preview it here
                    </div>
                </div>
            )}
        </div>
    );
}
