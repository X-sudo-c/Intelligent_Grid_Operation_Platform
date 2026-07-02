import type { DuplicatePhotoEntry } from '../lib/giopDqDuplicateDiff';

interface DqDuplicatePhotoCompareProps {
  photos: DuplicatePhotoEntry[];
  isLightMode: boolean;
  onSelect: (mrid: string) => void;
}

export function DqDuplicatePhotoCompare({
  photos,
  isLightMode,
  onSelect,
}: DqDuplicatePhotoCompareProps) {
  if (photos.length < 2) return null;
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const frame = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/40 bg-premium-card/70';

  return (
    <div className={`rounded-lg border px-2.5 py-2 ${frame}`}>
      <p className={`text-xs font-medium mb-2 ${muted}`}>Photo compare ({photos.length})</p>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {photos.map((photo) => (
          <button
            key={photo.mrid}
            type="button"
            onClick={() => onSelect(photo.mrid)}
            className={`shrink-0 w-28 rounded-lg border overflow-hidden text-left transition ${
              photo.isActive
                ? 'border-premium-accent/40 ring-1 ring-premium-accent/20'
                : isLightMode
                  ? 'border-slate-200 hover:border-amber-400'
                  : 'border-premium-border/45 hover:border-premium-warn-border/50'
            }`}
          >
            <img
              src={photo.photoUrl}
              alt={photo.name || photo.mrid}
              className="h-20 w-full object-cover bg-slate-100 dark:bg-premium-surface"
              loading="lazy"
            />
            <p className={`text-[10px] px-1.5 py-1 truncate ${muted}`}>
              {photo.name || photo.mrid.slice(0, 8)}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
