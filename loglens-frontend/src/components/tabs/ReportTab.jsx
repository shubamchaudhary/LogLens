import { fmtTime } from '../../utils/format';
import Markdown from '../Markdown';
import Icon from '../Icon';

/**
 * Final incident report. The backend stores it as markdown (content_md); we
 * render it as a proper formatted document (headings, lists, tables).
 */
export default function ReportTab({ report }) {
  if (!report || !report.contentMd) {
    return (
      <div className="card p-10 text-center">
        <p className="text-sm font-medium text-slate-700">No report yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
          A report is generated once correlation finishes. If the run just completed, give it a moment and refresh.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-6 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Icon name="file" className="h-4 w-4 text-violet-600" /> Incident report
        </h3>
        <span className="text-xs text-slate-400">Generated {fmtTime(report.generatedAt)}</span>
      </div>
      <div className="px-6 py-5">
        <Markdown>{report.contentMd}</Markdown>
      </div>
    </div>
  );
}
