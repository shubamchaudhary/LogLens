import { useRef, useState } from 'react';
import { documentAPI } from '../services/api';

/**
 * Drop or pick a single log file to start a session's analysis. On success the
 * backend returns 202 and the pipeline begins; the parent starts the live
 * progress stream.
 */
export default function UploadPanel({ sessionId, onUploaded }) {
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
      await documentAPI.upload(sessionId, file, (e) => {
        if (e.total) setPct(Math.round((e.loaded / e.total) * 100));
      });
      onUploaded?.(file.name);
    } catch (e) {
      const status = e.response?.status;
      if (status === 404) setError('Session not found.');
      else if (status === 400) setError('That file looks empty.');
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
    <div className="bg-white rounded-xl border border-gray-200 p-8">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !uploading && inputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragging ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-indigo-400'
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
          className="mx-auto h-12 w-12 text-gray-400"
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
            <p className="text-sm text-gray-600 mb-2">Uploading… {pct}%</p>
            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className="bg-indigo-600 h-2 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : (
          <>
            <p className="mt-4 text-sm font-medium text-gray-700">
              Drop a log file here, or click to browse
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Plain-text application logs work best (.log, .txt)
            </p>
          </>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
