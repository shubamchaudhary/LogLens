import { fmtTime } from '../../utils/format';

/**
 * Final incident report. The backend stores it as markdown (content_md); we
 * render it in a readable, whitespace-preserving block (no markdown dependency).
 */
export default function ReportTab({ report }) {
  if (!report || !report.contentMd) {
    return (
      <EmptyState
        title="No report yet"
        body="A report is generated once correlation finishes. If the run just completed, give it a moment and refresh."
      />
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800">Incident report</h3>
        <span className="text-xs text-gray-400">Generated {fmtTime(report.generatedAt)}</span>
      </div>
      <div className="p-6">
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800 font-[system-ui]">
          {report.contentMd}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ title, body }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
      <p className="text-sm font-medium text-gray-700">{title}</p>
      <p className="mt-1 text-sm text-gray-400 max-w-md mx-auto">{body}</p>
    </div>
  );
}
