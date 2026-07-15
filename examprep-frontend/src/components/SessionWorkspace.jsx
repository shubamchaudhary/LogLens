import { useCallback, useEffect, useRef, useState } from 'react';
import { analysisAPI, streamProgress } from '../services/api';
import StatusBadge from './StatusBadge';
import { isTerminal } from '../utils/status';
import ProgressTracker from './ProgressTracker';
import UploadPanel from './UploadPanel';
import DrilldownPanel from './DrilldownPanel';
import ReportTab from './tabs/ReportTab';
import FindingsTab from './tabs/FindingsTab';
import IncidentsTab from './tabs/IncidentsTab';
import MetricsTab from './tabs/MetricsTab';

const TABS = [
  ['report', 'Report'],
  ['findings', 'Findings'],
  ['incidents', 'Incidents'],
  ['metrics', 'Metrics'],
  ['ask', 'Ask'],
];

/**
 * Main panel for one session: upload → live progress → result tabs + drill-down.
 * Progress is driven by the SSE stream; when the run reaches a terminal state we
 * pull the metrics/findings/incidents/report the pipeline produced.
 */
export default function SessionWorkspace({ session, onStatusChange }) {
  const sessionId = session.id;
  const [progress, setProgress] = useState({
    status: session.analysisStatus,
    enriched: session.enrichedWindows ?? 0,
    total: session.totalWindows ?? 0,
  });
  const [tab, setTab] = useState('report');
  const [results, setResults] = useState(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
    setTab('report');

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
    });
    return () => abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const status = progress.status;
  const showUpload = status === 'CREATED' && !starting;
  const showProgress = !isTerminal(status) && !showUpload;

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900 truncate">{session.title}</h2>
          <p className="text-xs text-gray-400 truncate">{sessionId}</p>
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {status === 'FAILED' && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-4">
            <p className="text-sm font-medium text-red-800">Analysis failed</p>
            {session.errorMessage && (
              <p className="mt-1 text-sm text-red-700">{session.errorMessage}</p>
            )}
            <p className="mt-1 text-xs text-red-500">Any partial results are shown below.</p>
          </div>
        )}

        {showUpload && (
          <div className="max-w-2xl mx-auto mt-8">
            <div className="text-center mb-6">
              <h3 className="text-lg font-semibold text-gray-900">Upload a log to analyze</h3>
              <p className="text-sm text-gray-500 mt-1">
                We'll chunk it, extract metrics, enrich anomalies with an LLM, and correlate the
                findings into incidents.
              </p>
            </div>
            <UploadPanel
              sessionId={sessionId}
              onUploaded={() => {
                setStarting(true);
                setProgress((p) => ({ ...p, status: 'CHUNKING' }));
              }}
            />
          </div>
        )}

        {showProgress && (
          <div className="max-w-3xl mx-auto mt-6">
            <ProgressTracker progress={progress} />
          </div>
        )}

        {isTerminal(status) && (
          <div className="max-w-4xl mx-auto">
            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-gray-200 mb-4">
              {TABS.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === key
                      ? 'border-indigo-600 text-indigo-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
              {loadingResults && (
                <span className="ml-auto text-xs text-gray-400 self-center">Loading…</span>
              )}
            </div>

            {tab === 'ask' ? (
              <DrilldownPanel sessionId={sessionId} />
            ) : loadingResults && !results ? (
              <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-400">
                Loading results…
              </div>
            ) : (
              <>
                {tab === 'report' && <ReportTab report={results?.report} />}
                {tab === 'findings' && <FindingsTab findings={results?.findings} />}
                {tab === 'incidents' && (
                  <IncidentsTab incidents={results?.incidents} findings={results?.findings} />
                )}
                {tab === 'metrics' && <MetricsTab metrics={results?.metrics} />}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
