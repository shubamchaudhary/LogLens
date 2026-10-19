import { useCallback, useEffect, useRef, useState } from 'react';
import { analysisAPI, streamProgress } from '../services/api';
import StatusBadge from './StatusBadge';
import { isTerminal } from '../utils/status';
import ProgressTracker from './ProgressTracker';
import PipelineConsole from './PipelineConsole';
import UploadPanel from './UploadPanel';
import DrilldownPanel from './DrilldownPanel';
import DemoBanner from './DemoBanner';
import Icon from './Icon';
import OverviewTab from './tabs/OverviewTab';
import ReportTab from './tabs/ReportTab';
import FindingsTab from './tabs/FindingsTab';
import IncidentsTab from './tabs/IncidentsTab';
import MetricsTab from './tabs/MetricsTab';
import { isDemo } from '../demo/demoMode';
import { loadFixture, skipReplay } from '../demo/demoApi';

const TABS = [
  ['overview', 'Overview', 'chart'],
  ['report', 'Report', 'file'],
  ['findings', 'Findings', 'list'],
  ['incidents', 'Incidents', 'layers'],
  ['metrics', 'Metrics', 'grid'],
  ['ask', 'Ask', 'message'],
];

/**
 * Main panel for one session: upload → live progress → result tabs + drill-down.
 * Progress is driven by the SSE stream; when the run reaches a terminal state we
 * pull the metrics/findings/incidents/report the pipeline produced.
 */
export default function SessionWorkspace({ session, onStatusChange, onReplay }) {
  const sessionId = session.id;
  const demo = isDemo();
  const [progress, setProgress] = useState({
    status: session.analysisStatus,
    enriched: session.enrichedWindows ?? 0,
    total: session.totalWindows ?? 0,
  });
  const [tab, setTab] = useState('overview');
  const [results, setResults] = useState(null);
  const [stats, setStats] = useState(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [starting, setStarting] = useState(false);
  const [consoleLines, setConsoleLines] = useState([]);
  const startedAt = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (demo) loadFixture().then((f) => mounted.current && setStats(f.stats));
  }, [demo]);

  const loadResults = useCallback(async () => {
    setLoadingResults(true);
    try {
      const [rep, fin, inc, met] = await Promise.all([
        analysisAPI.report(sessionId),
        analysisAPI.findings(sessionId),
        analysisAPI.incidents(sessionId),
        analysisAPI.metrics(sessionId),
      ]);
      if (!mounted.current) return;
      setResults({
        report: rep.status === 204 ? null : rep.data,
        findings: fin.data || [],
        incidents: inc.data || [],
        metrics: met.data || [],
      });
    } catch (e) {
      console.error('Failed to load analysis results', e);
    } finally {
      if (mounted.current) setLoadingResults(false);
    }
  }, [sessionId]);

  // (Re)subscribe whenever a different session is selected.
  useEffect(() => {
    const seed = {
      status: session.analysisStatus,
      enriched: session.enrichedWindows ?? 0,
      total: session.totalWindows ?? 0,
    };
    setProgress(seed);
    setResults(null);
    setStarting(false);
    setTab('overview');
    setConsoleLines([]);

    if (isTerminal(seed.status)) {
      loadResults();
      return undefined;
    }

    const abort = streamProgress(sessionId, {
      onUpdate: (p) => {
        if (!mounted.current) return;
        setProgress(p);
        setStarting(false);
        onStatusChange?.({
          id: sessionId,
          analysisStatus: p.status,
          enrichedWindows: p.enriched,
          totalWindows: p.total,
        });
        if (isTerminal(p.status)) loadResults();
      },
      onLog: (line) => {
        if (!mounted.current) return;
        if (!startedAt.current) startedAt.current = Date.now();
        setConsoleLines((prev) => [...prev, { ...line, t: Date.now() - startedAt.current }]);
      },
    });
    return () => abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const status = progress.status;
  const showUpload = status === 'CREATED' && !starting;
  const showProgress = !isTerminal(status) && !showUpload;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {demo && <DemoBanner />}

      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-slate-900">{session.title}</h2>
          <p className="truncate font-mono text-[11px] text-slate-400">{sessionId}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {demo && showProgress && (
            <button onClick={skipReplay} className="btn-ghost">
              <Icon name="skip" className="h-3.5 w-3.5" /> Skip to results
            </button>
          )}
          {demo && isTerminal(status) && onReplay && (
            <button onClick={onReplay} className="btn-ghost">
              <Icon name="rotate" className="h-3.5 w-3.5" /> Replay analysis
            </button>
          )}
          <StatusBadge status={status} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {status === 'FAILED' && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-4">
            <p className="text-sm font-medium text-rose-800">Analysis failed</p>
            {session.errorMessage && <p className="mt-1 text-sm text-rose-700">{session.errorMessage}</p>}
            <p className="mt-1 text-xs text-rose-500">Any partial results are shown below.</p>
          </div>
        )}

        {showUpload && (
          <div className="mx-auto mt-4 max-w-3xl">
            <div className="mb-6 text-center">
              <h3 className="text-xl font-bold tracking-tight text-slate-900">
                {demo ? 'Run the pipeline on a real log file' : 'Upload a log to analyze'}
              </h3>
              <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500">
                We'll split it, compute exact metrics with deterministic parsers, send only the anomalous minutes to an
                LLM, and correlate the findings into incidents.
              </p>
            </div>
            <UploadPanel
              sessionId={sessionId}
              onUploaded={() => {
                startedAt.current = 0;
                setStarting(true);
                setProgress((p) => ({ ...p, status: 'CHUNKING' }));
              }}
            />
          </div>
        )}

        {showProgress && (
          <div className="mx-auto mt-2 max-w-4xl space-y-4">
            <ProgressTracker progress={progress} />
            {consoleLines.length > 0 && <PipelineConsole lines={consoleLines} running />}
          </div>
        )}

        {isTerminal(status) && (
          <div className="mx-auto max-w-6xl">
            <div className="-mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <div className="inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
                {TABS.map(([key, label, icon]) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      tab === key
                        ? 'bg-gradient-to-r from-violet-600 to-pink-500 text-white shadow'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                    }`}
                  >
                    <Icon name={icon} className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {tab === 'ask' ? (
              <DrilldownPanel sessionId={sessionId} />
            ) : loadingResults && !results ? (
              <div className="card p-10 text-center text-sm text-slate-400">Loading results…</div>
            ) : (
              <div key={tab} className="animate-fade-up">
                {tab === 'overview' && <OverviewTab results={results} stats={stats} onOpenTab={setTab} />}
                {tab === 'report' && <ReportTab report={results?.report} />}
                {tab === 'findings' && <FindingsTab sessionId={sessionId} findings={results?.findings} />}
                {tab === 'incidents' && <IncidentsTab incidents={results?.incidents} findings={results?.findings} />}
                {tab === 'metrics' && <MetricsTab metrics={results?.metrics} />}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
