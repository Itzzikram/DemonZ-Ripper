import { useState, useEffect, useRef } from 'react';

const API_BASE = '/api/rip';

interface RipPageProps {
    onJobCreated: (id: string) => void;
    onViewResults: () => void;
}

interface JobStatus {
    id: string;
    url: string;
    status: 'queued' | 'running' | 'complete' | 'failed';
    progress: number;
    error?: string;
    stats?: {
        meshCount: number;
        textureCount: number;
        shaderCount: number;
        drawCallCount: number;
        fileSizeBytes: number;
        captureTimeMs: number;
    };
}

/* ---- Phase label mapping ---- */
const PHASE_LABELS: Record<number, string> = {
    0: 'Queued — waiting for slot…',
    10: 'Starting headless browser…',
    20: 'Loading target page…',
    30: 'Injecting WebGL hook…',
    40: 'Capturing draw calls…',
    50: 'Capturing textures & shaders…',
    60: 'Waiting for render frames…',
    70: 'Building GLB file…',
    80: 'Finalizing export…',
    90: 'Writing output…',
    100: 'Complete!',
};

function getPhaseLabel(progress: number): string {
    const thresholds = Object.keys(PHASE_LABELS).map(Number).sort((a, b) => b - a);
    for (const t of thresholds) {
        if (progress >= t) return PHASE_LABELS[t];
    }
    return 'Processing…';
}

/* ---- Viewport presets ---- */
const VIEWPORT_PRESETS = [
    { label: '720p', w: 1280, h: 720 },
    { label: '1080p', w: 1920, h: 1080 },
    { label: '4K', w: 3840, h: 2160 },
    { label: 'Mobile', w: 412, h: 915 },
] as const;

export default function RipPage({ onJobCreated, onViewResults }: RipPageProps) {
    const [url, setUrl] = useState('');
    const [captureTextures, setCaptureTextures] = useState(true);
    const [captureShaders, setCaptureShaders] = useState(true);
    const [exportFormat, setExportFormat] = useState<'glb' | 'gltf' | 'obj' | 'uasset'>('glb');
    const [captureDuration, setCaptureDuration] = useState(3000);
    const [viewportPreset, setViewportPreset] = useState(1); // index into VIEWPORT_PRESETS
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [urlError, setUrlError] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Poll job status
    useEffect(() => {
        if (!activeJob || activeJob.status === 'complete' || activeJob.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            return;
        }

        pollRef.current = setInterval(async () => {
            try {
                const res = await fetch(`${API_BASE}/status/${activeJob.id}`);
                if (res.ok) {
                    const data = await res.json();
                    setActiveJob(data);
                } else if (res.status === 404) {
                    // Job was deleted externally — clear stale UI
                    setActiveJob(null);
                }
            } catch { /* ignore polling errors */ }
        }, 1000);

        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [activeJob?.id, activeJob?.status]);

    // URL validation
    const validateUrl = (value: string) => {
        if (!value.trim()) { setUrlError(null); return; }
        try {
            const parsed = new URL(value.trim());
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                setUrlError('Only HTTP/HTTPS URLs are supported');
            } else {
                setUrlError(null);
            }
        } catch {
            setUrlError('Enter a valid URL (e.g. https://example.com)');
        }
    };

    const handleUrlChange = (value: string) => {
        setUrl(value);
        validateUrl(value);
    };

    const handleSubmit = async (overrideUrl?: string) => {
        const targetUrl = (overrideUrl ?? url).trim();
        if (!targetUrl || urlError) return;
        setIsSubmitting(true);
        setError(null);
        setActiveJob(null);

        const vp = VIEWPORT_PRESETS[viewportPreset];

        try {
            const res = await fetch(`${API_BASE}/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: targetUrl,
                    captureTextures,
                    captureShaders,
                    exportFormat,
                    captureDuration,
                    viewportWidth: vp.w,
                    viewportHeight: vp.h,
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to start rip');
            }

            const data = await res.json();
            onJobCreated(data.jobId);
            setActiveJob({
                id: data.jobId,
                url: targetUrl,
                status: 'queued',
                progress: 0,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleRetry = () => {
        if (activeJob) handleSubmit(activeJob.url);
    };

    const handleDownload = () => {
        if (!activeJob) return;
        window.open(`${API_BASE}/download/${activeJob.id}`, '_blank');
    };

    const getStatusBadge = (status: string) => {
        const classes: Record<string, string> = {
            queued: 'badge badge-queued',
            running: 'badge badge-running',
            complete: 'badge badge-complete',
            failed: 'badge badge-failed',
        };
        return (
            <span className={classes[status] ?? 'badge'}>
                <span className="badge-dot" />
                {status.charAt(0).toUpperCase() + status.slice(1)}
            </span>
        );
    };

    const isRunning = activeJob?.status === 'running' || activeJob?.status === 'queued';

    return (
        <div className="rip-layout fade-in">
            {/* Main area */}
            <div className="rip-main">
                {/* URL Input */}
                <div className="card card-glow slide-up">
                    <div className="card-title">
                        <span className="icon">🎯</span>
                        Target URL
                    </div>
                    <div className="url-input-wrapper">
                        <input
                            id="target-url-input"
                            type="url"
                            className={`input-field large ${urlError ? 'input-error' : ''}`}
                            placeholder="https://www.fab.com/listings/your-3d-model"
                            value={url}
                            onChange={(e) => handleUrlChange(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                            disabled={isSubmitting || isRunning}
                        />
                        <button
                            id="start-rip-btn"
                            className="btn btn-primary url-submit-btn"
                            onClick={() => handleSubmit()}
                            disabled={!url.trim() || !!urlError || isSubmitting || isRunning}
                        >
                            {isSubmitting ? <span className="spinner" /> : '⚡ Rip'}
                        </button>
                    </div>
                    {urlError && (
                        <div className="input-hint input-hint-error">{urlError}</div>
                    )}
                    {error && (
                        <div style={{ marginTop: 12, color: 'var(--neon-red)', fontSize: 13 }}>
                            ⚠ {error}
                        </div>
                    )}
                </div>

                {/* Active Job Progress */}
                {activeJob && (
                    <div className="card slide-up stagger-1">
                        <div className="card-title" style={{ justifyContent: 'space-between' }}>
                            <span>
                                <span className="icon">📡</span>
                                {' '}Rip Session
                            </span>
                            {getStatusBadge(activeJob.status)}
                        </div>

                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, wordBreak: 'break-all' }}>
                            {activeJob.url}
                        </div>

                        {/* Progress bar with phase labels */}
                        {(activeJob.status === 'queued' || activeJob.status === 'running') && (
                            <div className="progress-container">
                                <div className="progress-header">
                                    <span className="progress-label">
                                        {getPhaseLabel(activeJob.progress)}
                                    </span>
                                    <span className="progress-value">{activeJob.progress}%</span>
                                </div>
                                <div className="progress-bar">
                                    <div className="progress-fill" style={{ width: `${activeJob.progress}%` }} />
                                </div>
                            </div>
                        )}

                        {/* Stats on completion */}
                        {activeJob.status === 'complete' && activeJob.stats && (
                            <>
                                <div className="stats-grid">
                                    <div className="stat-item">
                                        <div className="stat-value">{activeJob.stats.meshCount}</div>
                                        <div className="stat-label">Meshes</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value">{activeJob.stats.textureCount}</div>
                                        <div className="stat-label">Textures</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value">{activeJob.stats.shaderCount}</div>
                                        <div className="stat-label">Shaders</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value">{activeJob.stats.drawCallCount}</div>
                                        <div className="stat-label">Draw Calls</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value">
                                            {(activeJob.stats.fileSizeBytes / 1024 / 1024).toFixed(1)}
                                        </div>
                                        <div className="stat-label">MB Output</div>
                                    </div>
                                    <div className="stat-item">
                                        <div className="stat-value">
                                            {(activeJob.stats.captureTimeMs / 1000).toFixed(1)}s
                                        </div>
                                        <div className="stat-label">Capture Time</div>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
                                    <button className="btn btn-success" onClick={handleDownload} id="download-btn">
                                        ⬇ Download .{exportFormat.toUpperCase()}
                                    </button>
                                    {exportFormat === 'uasset' && (
                                        <button className="btn btn-primary" onClick={() => {
                                            if (activeJob) window.open(`${API_BASE}/download/${activeJob.id}/uassets`, '_blank');
                                        }}>
                                            📂 Browse UAsset Files
                                        </button>
                                    )}
                                    <button className="btn btn-secondary" onClick={onViewResults}>
                                        📦 View All Results
                                    </button>
                                </div>
                            </>
                        )}

                        {/* Error state with retry */}
                        {activeJob.status === 'failed' && (
                            <div className="error-box">
                                <div className="error-title">Rip Failed</div>
                                <div className="error-message">
                                    {activeJob.error || 'An unknown error occurred.'}
                                </div>
                                <button className="btn btn-primary" onClick={handleRetry} style={{ marginTop: 12 }}>
                                    🔄 Retry
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* Empty state */}
                {!activeJob && (
                    <div className="card slide-up stagger-2">
                        <div className="empty-state">
                            <div className="icon">🎮</div>
                            <h3>Ready to Rip</h3>
                            <p>
                                Paste a Fab.com product URL (with 3D Viewer) or any WebGL-powered
                                page to extract 3D models, textures, shaders, and geometry.
                            </p>
                        </div>
                    </div>
                )}
            </div>

            {/* Sidebar — Options */}
            <div className="rip-sidebar">
                <div className="card slide-up stagger-2">
                    <div className="card-title">
                        <span className="icon">⚙️</span>
                        Capture Options
                    </div>

                    {/* Textures toggle */}
                    <div className="toggle-group">
                        <div>
                            <div className="toggle-label-text">Textures</div>
                            <div className="toggle-desc">Capture all bound textures</div>
                        </div>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={captureTextures}
                                onChange={(e) => setCaptureTextures(e.target.checked)}
                            />
                            <span className="toggle-slider" />
                        </label>
                    </div>

                    {/* Shaders toggle */}
                    <div className="toggle-group" style={{ borderBottom: 'none' }}>
                        <div>
                            <div className="toggle-label-text">Shaders</div>
                            <div className="toggle-desc">Extract GLSL source code</div>
                        </div>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={captureShaders}
                                onChange={(e) => setCaptureShaders(e.target.checked)}
                            />
                            <span className="toggle-slider" />
                        </label>
                    </div>
                </div>

                {/* Export settings */}
                <div className="card slide-up stagger-3">
                    <div className="card-title">
                        <span className="icon">📁</span>
                        Export Format
                    </div>

                    <div className="input-group">
                        <label className="input-label" htmlFor="format-select">Output format</label>
                        <select
                            id="format-select"
                            className="select-field"
                            value={exportFormat}
                            onChange={(e) => setExportFormat(e.target.value as 'glb' | 'gltf' | 'obj' | 'uasset')}
                        >
                            <option value="glb">GLB (Binary glTF)</option>
                            <option value="gltf">glTF + Assets</option>
                            <option value="obj">OBJ + MTL</option>
                            <option value="uasset">UAsset (Unreal Engine)</option>
                        </select>
                    </div>

                    <div className="input-group">
                        <label className="input-label" htmlFor="duration-input">Capture duration (ms)</label>
                        <input
                            id="duration-input"
                            type="number"
                            className="input-field"
                            value={captureDuration}
                            onChange={(e) => setCaptureDuration(parseInt(e.target.value) || 3000)}
                            min={500}
                            max={30000}
                            step={500}
                        />
                    </div>

                    {/* Viewport presets */}
                    <div className="input-group" style={{ marginBottom: 0 }}>
                        <label className="input-label">Viewport</label>
                        <div className="viewport-presets">
                            {VIEWPORT_PRESETS.map((preset, i) => (
                                <button
                                    key={preset.label}
                                    className={`viewport-pill ${viewportPreset === i ? 'active' : ''}`}
                                    onClick={() => setViewportPreset(i)}
                                >
                                    {preset.label}
                                    <span className="viewport-pill-dim">{preset.w}×{preset.h}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Quick info */}
                <div className="card slide-up stagger-4" style={{ background: 'rgba(0, 240, 255, 0.03)', borderColor: 'rgba(0, 240, 255, 0.1)' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                        <strong style={{ color: 'var(--neon-cyan)' }}>How it works:</strong>
                        <br />
                        DemonZ Ripper opens any WebGL page in a headless browser, intercepts all draw calls, and captures geometry, textures & shaders. <em>Works with Fab.com 3D Viewer, Sketchfab, Three.js scenes, and any WebGL-powered site!</em>
                    </div>
                </div>
            </div>
        </div>
    );
}
