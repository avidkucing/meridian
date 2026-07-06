interface BinRangeBarProps {
  lowerBin?: number | null;
  upperBin?: number | null;
  activeBin?: number | null;
}

export function BinRangeBar({ lowerBin, upperBin, activeBin }: BinRangeBarProps) {
  if (lowerBin == null || upperBin == null || activeBin == null) {
    return <span className="text-text-mute">—</span>;
  }

  const inRange = activeBin >= lowerBin && activeBin <= upperBin;
  const totalRange = upperBin - lowerBin || 1;
  const offset = Math.max(0, Math.min(1, (activeBin - lowerBin) / totalRange));

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-20 overflow-visible rounded-full bg-surface-2">
        <div
          className={`absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border-2 border-bg ${
            inRange ? "bg-green" : "bg-red"
          }`}
          style={{ left: `calc(${offset * 100}% - 5px)` }}
        />
      </div>
      <span className={`whitespace-nowrap text-[10px] font-medium ${inRange ? "text-green" : "text-red"}`}>
        {inRange ? "in range" : "OOR"}
      </span>
    </div>
  );
}
