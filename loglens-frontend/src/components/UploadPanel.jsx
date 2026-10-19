import { useEffect, useRef, useState } from 'react';
import { documentAPI } from '../services/api';
import { isDemo } from '../demo/demoMode';
import { loadFixture } from '../demo/demoApi';
import { fmtBytes, fmtClock } from '../utils/format';
import Icon from './Icon';
import LogViewer from './LogViewer';

/**
 * Drop or pick a single log file to start a session's analysis. On success the
 * backend returns 202 and the pipeline begins; the parent starts the live
 * progress stream.
 */
export default function UploadPanel(props) {
  return isDemo() ? <SampleUpload {...props} /> : <FileUpload {...props} />;
}

function FileUpload({ sessionId, onUploaded }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState('');

  const doUpload = async (file) => {
    if (!file) return;
    setError('');
    setUploading(true);
    setPct(0);
    try {
      // Direct-to-blob: the file bytes go straight to storage via a presigned
      // URL; the backend never handles them. Progress tracks the PUT to storage.
      await documentAPI.uploadDirect(sessionId, file, (e) => {
        if (e.total) setPct(Math.round((e.loaded / e.total) * 100));
      });
      onUploaded?.(file.name);
    } catch (e) {
      const status = e.response?.status;
      if (status === 404) setError('Session not found.');
      else if (status === 400) setError('Upload did not complete — please try again.');
      else setError(e.response?.data?.message || 'Upload failed. Is the backend running?');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) doUpload(file);
  };

  return (
    <div className="card p-8">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !uploading && inputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragging ? 'border-violet-500 bg-violet-50' : 'border-slate-300 hover:border-violet-400'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept=".log,.txt,.gz,.zip,.json,text/plain"
          onChange={(e) => doUpload(e.target.files?.[0])}
        />
        <svg
          className="mx-auto h-12 w-12 text-violet-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>
        {uploading ? (
          <div className="mt-4">
            <p className="text-sm text-slate-600 mb-2">Uploading… {pct}%</p>
            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
              <div
                className="bg-gradient-to-r from-violet-600 to-pink-500 h-2 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : (
          <>
            <p className="mt-4 text-sm font-medium text-slate-700">
              Drop a log file here, or click to browse
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Plain-text application logs work best (.log, .txt)
            </p>
          </>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
    </div>
  );
}

/**
 * Demo mode: no file picker (uploads need the backend). The visitor runs the
 * pipeline on the bundled sample log instead; we show what's in it first.
 */
function SampleUpload({ sessionId, onUploaded }) {
  const [sample, setSample] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [pct, setPct] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadFixture().then((f) => {
      if (cancelled) return;
      // An excerpt where things start going wrong: the first flagged window.
      const first = Object.values(f.chunks).sort((a, b) => a.lineStart - b.lineStart)[0];
      const excerpt = first.content.split('\n').slice(0, 8).join('\n');
      setSample({ file: f.file, stats: f.stats, excerpt, lineStart: first.lineStart });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async () => {
    setUploading(true);
    await documentAPI.uploadDirect(sessionId, sample.file, (e) => setPct(Math.round((e.loaded / e.total) * 100)));
    onUploaded?.(sample.file.name);
  };

  if (!sample) {
    return <div className="card h-72 animate-pulse" />;
  }

  return (
    <div className="card p-6">
      <div className="flex flex-wrap items-center gap-4">
        <span className="icon-tile h-12 w-12">
          <Icon name="file" className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold text-slate-900">{sample.file.name}</p>
          <p className="text-xs text-slate-500">
            {fmtBytes(sample.file.bytes)} · {sample.file.lines.toLocaleString('en-US')} lines · {sample.file.services}{' '}
            services · {sample.file.tenants} tenants · {fmtClock(sample.file.from).slice(0, 5)}–
            {fmtClock(sample.file.to).slice(0, 5)} UTC
          </p>
        </div>
        <button onClick={run} disabled={uploading} className="btn-primary w-full sm:w-auto">
          {uploading ? (
            `Uploading… ${pct}%`
          ) : (
            <>
              <Icon name="play" className="h-4 w-4" /> Analyze this log
            </>
          )}
        </button>
      </div>

      {uploading && (
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-600 to-pink-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <div className="mt-5">
        <LogViewer content={sample.excerpt} lineStart={sample.lineStart} title="excerpt · where things start to go wrong" maxHeight="max-h-56" />
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-500">
        <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Uploading your own file needs the live backend (Kafka, Postgres, LLM keys), which is paused to keep hosting
        free. Clone the repo to run it on your logs.
      </p>
    </div>
  );
}
