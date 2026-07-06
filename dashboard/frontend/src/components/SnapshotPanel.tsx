import type { Field } from "../lib/snapshotFields";

function FieldGrid({ fields }: { fields: Field[] }) {
  if (!fields.length) {
    return <p className="text-xs text-text-mute">No data captured for this snapshot.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
      {fields.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <div className="truncate text-[10px] uppercase tracking-wide text-text-dim">{label}</div>
          <div className="truncate text-xs font-medium text-text" title={value ?? undefined}>
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

interface SnapshotPanelProps {
  title: string;
  fields: Field[];
}

function SnapshotCard({ title, fields }: SnapshotPanelProps) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-accent">{title}</h4>
      <FieldGrid fields={fields} />
    </div>
  );
}

export function SnapshotPanel({ panels }: { panels: SnapshotPanelProps[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 border-t border-border bg-bg/40 p-4 lg:grid-cols-2">
      {panels.map((panel) => (
        <SnapshotCard key={panel.title} {...panel} />
      ))}
    </div>
  );
}
