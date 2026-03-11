interface TextureGalleryProps {
    textures: {
        name: string;
        width: number;
        height: number;
        type: string;
        dataUrl?: string;
    }[];
}

export default function TextureGallery({ textures }: TextureGalleryProps) {
    if (textures.length === 0) {
        return (
            <div className="card">
                <div className="empty-state" style={{ padding: 30 }}>
                    <div className="icon" style={{ fontSize: 32 }}>🖼️</div>
                    <h3>No Textures Captured</h3>
                    <p>No texture data was extracted from this scene.</p>
                </div>
            </div>
        );
    }

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div className="card-title" style={{ margin: 0 }}>
                    <span className="icon">🖼️</span>
                    Textures ({textures.length})
                </div>
            </div>

            <div className="texture-grid">
                {textures.map((tex, i) => (
                    <div
                        key={`${tex.name}_${tex.width}x${tex.height}_${i}`}
                        className="texture-item fade-in"
                        style={{ animationDelay: `${i * 0.03}s` }}
                        title={`${tex.name}\n${tex.width}×${tex.height}\nType: ${tex.type}`}
                    >
                        {tex.dataUrl ? (
                            <img src={tex.dataUrl} alt={tex.name} />
                        ) : (
                            <div style={{
                                width: '100%',
                                height: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'repeating-conic-gradient(rgba(255,255,255,0.03) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px',
                                fontSize: 24,
                                color: 'var(--text-muted)',
                            }}>
                                🖼
                            </div>
                        )}
                        <div className="texture-label">
                            {tex.type}
                            <br />
                            {tex.width}×{tex.height}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
