interface Tab {
  id: string;
  label: string;
  count?: number;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <nav className="flex gap-1 border-b border-border px-8">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`relative px-4 py-3 text-sm font-medium transition-colors ${
              isActive ? "text-accent" : "text-text-dim hover:text-text"
            }`}
          >
            {tab.label}
            {tab.count != null && (
              <span className="ml-2 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-dim">
                {tab.count}
              </span>
            )}
            {isActive && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        );
      })}
    </nav>
  );
}
