import { STATUS_STYLES, isProcessing } from '../utils/status';

export default function StatusBadge({ status, className = '' }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.CREATED;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${s.cls} ${className}`}
    >
      {isProcessing(status) && (
        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {s.label}
    </span>
  );
}
