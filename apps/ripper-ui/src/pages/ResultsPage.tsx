import { useState, useEffect } from 'react';

const API_BASE = '/api/rip';

interface Job {
    id: string;
    url: string;
    status: 'queued' | 'running' | 'complete' | 'failed';
    progress: number;
    createdAt: string;
    completedAt?: string;
    stats?: {
        fileSizeBytes?: number;
        meshCount?: number;
        textureCount?: number;
    };
}

interface ResultsPageProps {
    highlightJobId: string | null;
}

export default function ResultsPage({ highlightJobId }: ResultsPageProps) {
    const [jobs, setJobs] = useState<Job[]>([]);
    const [loading, setLoading] = useState(true);

    // Only poll while there are active (queued/running) jobs
    const hasActiveJobs = jobs.some(j => j.status === 'queued' || j.status === 'running');

    useEffect(() => {
        fetchJobs();
    }, []);

    useEffect(() => {
        if (!hasActiveJobs && !loading) return;
        const interval = setInterval(fetchJobs, 3000);
        return () => clearInterval(interval);
    }, [hasActiveJobs, loading]);

    const fetchJobs = async () => {
        try {
            const res = await fetch(`${API_BASE}/jobs`);
            if (res.ok) {
                const data = await res.json();
                // Sort newest first
                data.sort((a: Job, b: Job) =>
                    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                );
                setJobs(data);
            }
        } catch { /* ignore */ }
        setLoading(false);
    };

    const handleDownload = (jobId: string) => {
        window.open(`${API_BASE}/download/${jobId}`, '_blank');
    };

    const handleDelete = async (jobId: string) => {
        try {
            const res = await fetch(`${API_BASE}/${jobId}`, { method: 'DELETE' });
            if (res.ok) {
                setJobs((prev) => prev.filter((j) => j.id !== jobId));
            }
        } catch { /* ignore */ }
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

    const formatTime = (iso: string) => {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const formatUrl = (url: string) => {
        try {
            const u = new URL(url);
            return u.hostname + (u.pathname !== '/' ? u.pathname : '');
        } catch {
            return url;
        }
    };

    const formatSize = (bytes?: number) => {
        if (!bytes) return '—';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };

    if (loading) {
        return (
            <div className="fade-in" style={{ textAlign: 'center', padding: 80 }}>
                <div className="spinner" style={{ margin: '0 auto 16px' }} />
                <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Loading results...</div>
            </div>
        );
    }

    if (jobs.length === 0) {
        return (
            <div className="card fade-in">
                <div className="empty-state">
                    <div className="icon">📦</div>
                    <h3>No Rip Results Yet</h3>
                    <p>
                        Start your first rip from the Rip tab. All completed extractions will appear here for download and preview.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <h2 style={{ fontSize: 18, fontWeight: 600 }}>
                    Rip Results
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 14, marginLeft: 8 }}>
                        ({jobs.length})
                    </span>
                </h2>
            </div>

            <div className="results-list">
                {jobs.map((job, i) => (
                    <div
                        key={job.id}
                        className="result-item slide-up"
                        style={{
                            animationDelay: `${i * 0.05}s`,
                            borderColor: job.id === highlightJobId ? 'rgba(0, 240, 255, 0.3)' : undefined,
                            background: job.id === highlightJobId ? 'rgba(0, 240, 255, 0.03)' : undefined,
                        }}
                    >
                        <div className="result-info">
                            <div className="result-url">{formatUrl(job.url)}</div>
                            <div className="result-meta">
                                {getStatusBadge(job.status)}
                                <span style={{ marginLeft: 12 }}>
                                    {formatTime(job.createdAt)}
                                </span>
                                {job.status === 'running' && (
                                    <span style={{ marginLeft: 12, color: 'var(--neon-cyan)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                                        {job.progress}%
                                    </span>
                                )}
                                {job.stats?.fileSizeBytes && (
                                    <span style={{ marginLeft: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                                        {formatSize(job.stats.fileSizeBytes)}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="result-actions">
                            {job.status === 'complete' && (
                                <button
                                    className="btn btn-success"
                                    onClick={() => handleDownload(job.id)}
                                    style={{ padding: '8px 16px', fontSize: 13 }}
                                >
                                    ⬇ Download
                                </button>
                            )}
                            {job.status === 'running' && (
                                <div className="spinner" />
                            )}
                            <button
                                className="btn btn-danger"
                                onClick={() => handleDelete(job.id)}
                                style={{ padding: '8px 12px', fontSize: 13 }}
                                title="Delete job"
                            >
                                🗑
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
