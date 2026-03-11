import { useState, useCallback } from 'react';
import RipPage from './pages/RipPage';
import ResultsPage from './pages/ResultsPage';

type Page = 'rip' | 'results';

export default function App() {
    const [activePage, setActivePage] = useState<Page>('rip');
    const [lastJobId, setLastJobId] = useState<string | null>(null);
    const [resultsKey, setResultsKey] = useState(0);

    const handleViewResults = useCallback(() => {
        setActivePage('results');
        setResultsKey((k) => k + 1); // trigger immediate re-fetch
    }, []);

    return (
        <div className="app-container">
            {/* Header */}
            <header className="app-header">
                <div className="header-inner">
                    <div className="logo">
                        <div className="logo-icon">D</div>
                        <div>
                            <div className="logo-text">DemonZ Ripper</div>
                            <div className="logo-tag">Fab.com & WebGL 3D Ripper</div>
                        </div>
                    </div>

                    <nav className="nav-tabs">
                        <button
                            className={`nav-tab ${activePage === 'rip' ? 'active' : ''}`}
                            onClick={() => setActivePage('rip')}
                        >
                            ⚡ Rip
                        </button>
                        <button
                            className={`nav-tab ${activePage === 'results' ? 'active' : ''}`}
                            onClick={handleViewResults}
                        >
                            📦 Results
                        </button>
                    </nav>
                </div>
            </header>

            {/* Pages — use CSS display to preserve state instead of unmounting */}
            <main>
                <div style={{ display: activePage === 'rip' ? 'block' : 'none' }}>
                    <RipPage
                        onJobCreated={(id) => {
                            setLastJobId(id);
                        }}
                        onViewResults={handleViewResults}
                    />
                </div>
                <div style={{ display: activePage === 'results' ? 'block' : 'none' }}>
                    <ResultsPage
                        highlightJobId={lastJobId}
                        key={resultsKey}
                    />
                </div>
            </main>
        </div>
    );
}
