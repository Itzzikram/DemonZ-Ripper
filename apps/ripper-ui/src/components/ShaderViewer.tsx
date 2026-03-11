import { useState } from 'react';

interface ShaderViewerProps {
    vertexSource: string;
    fragmentSource: string;
    programName: string;
}

export default function ShaderViewer({ vertexSource, fragmentSource, programName }: ShaderViewerProps) {
    const [activeTab, setActiveTab] = useState<'vertex' | 'fragment'>('fragment');

    return (
        <div className="shader-viewer">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {programName}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    GLSL
                </span>
            </div>
            <div className="shader-tabs">
                <button
                    className={`shader-tab ${activeTab === 'vertex' ? 'active' : ''}`}
                    onClick={() => setActiveTab('vertex')}
                >
                    vertex.glsl
                </button>
                <button
                    className={`shader-tab ${activeTab === 'fragment' ? 'active' : ''}`}
                    onClick={() => setActiveTab('fragment')}
                >
                    fragment.glsl
                </button>
            </div>
            <pre className="shader-code">
                {activeTab === 'vertex' ? vertexSource : fragmentSource}
            </pre>
        </div>
    );
}
