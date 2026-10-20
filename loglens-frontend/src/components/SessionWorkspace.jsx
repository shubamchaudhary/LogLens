import { useCallback, useEffect, useRef, useState } from 'react';
import { analysisAPI, streamProgress } from '../services/api';
import StatusBadge from './StatusBadge';
import { isTerminal } from '../utils/status';
import ProgressTracker from './ProgressTracker';
import PipelineConsole from './PipelineConsole';
import UploadPanel from './UploadPanel';
import AskPanel from './AskPanel';
import LogFileViewer from './LogFileViewer';
import Icon from './Icon';
import OverviewTab from './tabs/OverviewTab';
import IncidentsTab from './tabs/IncidentsTab';
import { isDemo } from '../demo/demoMode';
import { loadFixture, skipReplay } from '../demo/demoApi';
import { fmtBytes, fmtClock, fmtTime } from '../utils/format';
import { ThemeToggle } from './Site';

const TABS = [
  ['overview', 'Overview', 'chart'],
  ['incidents', 'Incidents', 'layers'],
  ['ask', 'Ask', 'message'],
];

/**
 * Main panel for one session: upload → live progress → Overview / Incidents / Ask.
 * Progress is driven by the SSE stream; when the run reaches a terminal state we
 * load the results.
 */
export default function SessionWorkspace({ session, onStatusChange, onReplay }) {
  const sessionId = session.id;
  const guest = isDemo();
  const [progress, setProgress] = useState({
    status: session.analysisStatus,
    enriched: session.enrichedWindows ?? 0,
    total: session.totalWindows ?? 0,
  });
  const [tab, setTab] = useState('overview');
  const [focus, setFocus] = useState(null);
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [sample, setSample] = useState(null); // the guest log's file facts
  const [loadingResults, setLoadingResults] = useState(false);
  const [starting, setStarting] = useState(false);
  const [consoleLines, setConsoleLines] = useState([]);
  const [viewer, setViewer] = useState(null); // { line, highlight }
  const startedAt = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (guest)
      loadFixture().then((f) => {
        if (!mounted.current) return;
        setStats(f.stats);
        setSample(f.file);
      });
  }, [guest]);

  const loadResults = useCallback(async () => {
    setLoadingResults(true);
    try {
      const res = await analysisAPI.overview(sessionId);
      if (mounted.current) setData(res.data);
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
    setData(null);
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
  const file = data?.file;

  // Under the title: the file and its size (what anyone knows before the analysis), or when the session was made.
  const facts = sample || file;
  const subtitle = facts
    ? `${facts.name} · ${fmtBytes(facts.bytes)}`
    : `Created ${fmtTime(session.createdAt)}`;

  const openIncident = (id) => {
    setFocus(id);
    setTab('incidents');
  };
  const openFile = file ? (line, highlight) => setViewer({ line, highlight }) : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink">{session.title}</h2>
          <p className="truncate text-xs text-muted">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {guest && showProgress && (
            <button onClick={skipReplay} className="btn-ghost">
              <Icon name="skip" className="h-3.5 w-3.5" /> Skip to results
            </button>
          )}
          {guest && isTerminal(status) && onReplay && (
            <button onClick={onReplay} className="btn-ghost">
              <Icon name="rotate" className="h-3.5 w-3.5" /> Run again
            </button>
          )}
          <StatusBadge status={status} />
          <ThemeToggle />
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto p-3 sm:p-4">
        {status === 'FAILED' && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
            <p className="text-sm font-medium text-rose-600">Analysis failed</p>
            {session.errorMessage && <p className="mt-1 text-sm text-rose-600">{session.errorMessage}</p>}
            <p className="mt-1 text-xs text-rose-500">Any partial results are shown below.</p>
          </div>
        )}

        {showUpload && (
          <div className="mx-auto mt-4 max-w-3xl">
            <h3 className="mb-6 text-center text-xl font-bold tracking-tight text-ink">
              {guest && sample ? `Analyse ${sample.name} (${fmtBytes(sample.bytes)})` : 'Upload a log to analyse'}
            </h3>
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
          <div className="mx-auto mt-2 w-full max-w-5xl space-y-4">
            <ProgressTracker progress={progress} stats={stats} />
            {consoleLines.length > 0 && <PipelineConsole lines={consoleLines} running />}
          </div>
        )}

        {isTerminal(status) && (
          <div className={`flex w-full flex-col ${tab === 'ask' ? 'min-h-0 flex-1' : ''}`}>
            <div className="-mx-4 mb-3 flex items-center justify-between gap-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <div className="inline-flex gap-1 rounded-xl border border-line bg-surface p-1 shadow-sm">
                {TABS.map(([key, label, icon]) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${
                      tab === key
                        ? 'bg-accent text-on-accent shadow'
                        : 'text-muted hover:bg-sand hover:text-ink'
                    }`}
                  >
                    <Icon name={icon} className="h-3.5 w-3.5" />
                    {label}
                    {key === 'incidents' && data?.incidents && (
                      <span className={`rounded-full px-1.5 text-[10px] ${tab === key ? 'bg-surface/25' : 'bg-sand'}`}>
                        {data.incidents.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {file && (
                <button onClick={() => setViewer({ line: 1 })} className="btn-ghost shrink-0">
                  <Icon name="file" className="h-3.5 w-3.5" /> {file.name}
                </button>
              )}
            </div>

            {loadingResults && !data ? (
              <div className="card p-10 text-center text-sm text-slate-400">Loading results…</div>
            ) : (
              <div key={tab} className={`animate-fade-up ${tab === 'ask' ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
                {tab === 'overview' && <OverviewTab data={data} onOpenIncident={openIncident} onOpenFile={openFile} />}
                {tab === 'incidents' && (
                  <IncidentsTab sessionId={sessionId} incidents={data?.incidents} focus={focus} onOpenFile={openFile} />
                )}
                {tab === 'ask' && <AskPanel sessionId={sessionId} suggestions={data?.suggestions} onOpenFile={openFile} />}
              </div>
            )}
          </div>
        )}
      </div>

      {viewer && file && (
        <LogFileViewer
          file={file}
          line={viewer.line}
          highlight={viewer.highlight}
          jumps={(data?.incidents || []).map((inc, i) => ({
            line: inc.evidence?.find((e) => e.role === 'first')?.line || inc.evidence?.[0]?.line,
            label: `#${i + 1} ${fmtClock(inc.start).slice(0, 5)}`,
          })).filter((j) => j.line)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
