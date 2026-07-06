import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Box, Search, UserRound, Wrench } from 'lucide-react';
import { useGiopVoiceMode } from '../context/GiopVoiceModeContext';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import { GiopTwistWaveCanvas } from './GiopTwistWaveCanvas';
import { GiopNetworkGeometryToggle } from './GiopNetworkGeometryToggle';
import { getMapGeocode, searchMap, type GiopMapSearchKind, type GiopMapSearchResult } from '../api/giop-api';
import {
  mergeGeocodePlaces,
  searchMapCatalog,
  type GiopMapSearchFilter,
} from '../lib/giopMapLocalSearch';

export type { GiopMapSearchFilter };

interface GiopMapSearchBarProps {
  isLightMode: boolean;
  placeCatalog: GiopMapSearchResult[];
  opsCatalog: GiopMapSearchResult[];
  placesReady?: boolean;
  onSelect: (result: GiopMapSearchResult) => void;
  /** Live camera preview while typing (best match). */
  onPreview: (result: GiopMapSearchResult | null) => void;
  /** Overlay = map top-center; inline = toolbar row; split = centered over Map + Topology. */
  variant?: 'overlay' | 'inline' | 'split';
  placeholder?: string;
  /** Map + Topology: hide field crew filter and crew results. */
  hideCrewFilter?: boolean;
  /** Side map / split toolbar: omit line-geometry layers control (shown elsewhere). */
  hideGeometryToggle?: boolean;
  gisOverviewAvailable?: boolean;
}

const FILTER_OPTIONS: {
  id: GiopMapSearchFilter;
  label: string;
  title: string;
  icon: typeof Search;
}[] = [
  { id: 'all', label: 'All', title: 'Search everything', icon: Search },
  { id: 'asset', label: 'Assets', title: 'Staging assets on map', icon: Box },
  { id: 'work_order', label: 'Orders', title: 'Work orders', icon: Wrench },
  { id: 'crew', label: 'Crews', title: 'Field technicians', icon: UserRound },
];

function kindLabel(result: GiopMapSearchResult): string {
  if (result.subtitle === 'Network node') {
    return 'Node';
  }
  if (result.kind === 'place' && result.id.startsWith('osm:')) {
    return 'Town';
  }
  switch (result.kind) {
    case 'asset':
      return 'Asset';
    case 'place':
      return 'District';
    case 'work_order':
      return 'Work order';
    case 'crew':
      return 'Field crew';
    default:
      return 'Result';
  }
}

function resultKey(result: GiopMapSearchResult): string {
  return `${result.kind}:${result.id}`;
}

export function GiopMapSearchBar({
  isLightMode,
  placeCatalog,
  opsCatalog,
  placesReady = true,
  onSelect,
  onPreview,
  variant = 'overlay',
  placeholder = 'Search map',
  hideCrewFilter = false,
  hideGeometryToggle = false,
  gisOverviewAvailable = true,
}: GiopMapSearchBarProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastPreviewKeyRef = useRef<string | null>(null);
  /** After confirm, hold preview until query or filter changes. */
  const confirmedRef = useRef<{ query: string; filter: GiopMapSearchFilter; key: string } | null>(
    null,
  );
  const geocodeSeqRef = useRef(0);
  const remoteSeqRef = useRef(0);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<GiopMapSearchFilter>('all');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [geocodeHits, setGeocodeHits] = useState<GiopMapSearchResult[]>([]);
  const [remoteHits, setRemoteHits] = useState<GiopMapSearchResult[]>([]);
  const [geocoding, setGeocoding] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);

  const wantsGeocode = filter === 'all';

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !wantsGeocode) {
      geocodeSeqRef.current += 1;
      setGeocodeHits([]);
      setGeocoding(false);
      return;
    }

    setGeocoding(true);
    const seq = ++geocodeSeqRef.current;
    const timer = window.setTimeout(() => {
      void getMapGeocode({ q, limit: 8 })
        .then((hits) => {
          if (seq !== geocodeSeqRef.current) return;
          setGeocodeHits(hits);
        })
        .catch(() => {
          if (seq !== geocodeSeqRef.current) return;
          setGeocodeHits([]);
        })
        .finally(() => {
          if (seq === geocodeSeqRef.current) setGeocoding(false);
        });
    }, 320);

    return () => window.clearTimeout(timer);
  }, [query, wantsGeocode]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      remoteSeqRef.current += 1;
      setRemoteHits([]);
      setRemoteLoading(false);
      return;
    }

    setRemoteLoading(true);
    const seq = ++remoteSeqRef.current;
    const timer = window.setTimeout(() => {
      void searchMap({ q, limit: 12 })
        .then((hits) => {
          if (seq !== remoteSeqRef.current) return;
          setRemoteHits(hits);
        })
        .catch(() => {
          if (seq !== remoteSeqRef.current) return;
          setRemoteHits([]);
        })
        .finally(() => {
          if (seq === remoteSeqRef.current) setRemoteLoading(false);
        });
    }, 420);

    return () => window.clearTimeout(timer);
  }, [query]);

  const placePool = useMemo(
    () => mergeGeocodePlaces(placeCatalog, geocodeHits),
    [placeCatalog, geocodeHits],
  );

  const filterOptions = useMemo(
    () => (hideCrewFilter ? FILTER_OPTIONS.filter((opt) => opt.id !== 'crew') : FILTER_OPTIONS),
    [hideCrewFilter],
  );

  const toolbarFilterOptions = useMemo(
    () => filterOptions.filter((opt) => opt.id !== 'asset'),
    [filterOptions],
  );

  const filteredOpsCatalog = useMemo(
    () => (hideCrewFilter ? opsCatalog.filter((item) => item.kind !== 'crew') : opsCatalog),
    [hideCrewFilter, opsCatalog],
  );

  const results = useMemo(
    () =>
      searchMapCatalog({
        filter,
        placeCatalog: placePool,
        opsCatalog: filteredOpsCatalog,
        query,
        limit: 12,
        geocodeHits: wantsGeocode ? geocodeHits : [],
        remoteHits,
      }),
    [filter, placePool, filteredOpsCatalog, query, wantsGeocode, geocodeHits, remoteHits],
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 1) {
      confirmedRef.current = null;
      lastPreviewKeyRef.current = null;
      onPreview(null);
      return;
    }

    if (
      confirmedRef.current &&
      confirmedRef.current.query === trimmed &&
      confirmedRef.current.filter === filter
    ) {
      return;
    }

    const best = searchMapCatalog({
      filter,
      placeCatalog: placePool,
      opsCatalog: filteredOpsCatalog,
      query,
      limit: 1,
      geocodeHits: wantsGeocode ? geocodeHits : [],
      remoteHits,
    })[0];

    if (!best) {
      lastPreviewKeyRef.current = null;
      return;
    }

    const key = resultKey(best);
    if (key === lastPreviewKeyRef.current) return;
    lastPreviewKeyRef.current = key;
    onPreview(best);
  }, [query, filter, placePool, filteredOpsCatalog, onPreview, wantsGeocode, geocodeHits, remoteHits]);

  const setSearchFilter = useCallback((next: GiopMapSearchFilter) => {
    if (next === filter) return;
    confirmedRef.current = null;
    lastPreviewKeyRef.current = null;
    setFilter(next);
    setOpen(true);
  }, [filter]);

  useEffect(() => {
    setActiveIndex(results.length > 0 ? 0 : -1);
  }, [results]);

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const pickResult = useCallback(
    (result: GiopMapSearchResult) => {
      const displayQuery = result.title.trim();
      const key = resultKey(result);
      confirmedRef.current = { query: displayQuery, filter, key };
      lastPreviewKeyRef.current = key;
      setQuery(displayQuery);
      onSelect(result);
      setOpen(false);
      inputRef.current?.blur();
    },
    [filter, onSelect],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        confirmedRef.current = null;
        if (!open) setOpen(true);
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        confirmedRef.current = null;
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (activeIndex >= 0 && results[activeIndex]) {
          pickResult(results[activeIndex]);
        } else if (results[0]) {
          pickResult(results[0]);
        }
        return;
      }
      if (event.key === 'Escape') {
        setOpen(false);
        setQuery('');
        confirmedRef.current = null;
        lastPreviewKeyRef.current = null;
        onPreview(null);
        inputRef.current?.blur();
      }
    },
    [activeIndex, open, onPreview, pickResult, results],
  );

  const showPanel = open && query.trim().length >= 1;
  const indexing = !placesReady && wantsGeocode;
  const busy = indexing || geocoding || remoteLoading;
  const voice = useGiopVoiceMode();
  const voiceActive = voice.mapVoiceActive || voice.recording;
  const { networkGeometryMode, setNetworkGeometryMode } = useGiopMapOverlay();

  return (
    <div
      ref={rootRef}
      className={`giop-map-spotlight ${variant === 'inline' ? 'giop-map-spotlight--inline' : ''} ${variant === 'split' ? 'giop-map-spotlight--split' : ''} ${isLightMode ? 'giop-map-spotlight--light' : 'giop-map-spotlight--dark'}`}
      role="search"
    >
      <div className="giop-map-spotlight__bar">
        <Search className="giop-map-spotlight__search-icon" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          inputMode="search"
          enterKeyHint="search"
          value={query}
          onChange={(e) => {
            confirmedRef.current = null;
            lastPreviewKeyRef.current = null;
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            inputRef.current?.select();
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="giop-map-spotlight__input"
          aria-label="Search map"
          aria-expanded={showPanel}
          aria-controls={listboxId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
        />
        {busy && <span className="giop-map-spotlight__spinner" aria-hidden />}
      </div>

      <div className="giop-map-spotlight__filters" role="group" aria-label="Search filters">
        {toolbarFilterOptions.slice(0, 1).map(({ id, title, icon: Icon }) => {
          const active = filter === id;
          return (
            <button
              key={id}
              type="button"
              title={title}
              aria-label={title}
              aria-pressed={active}
              onClick={() => setSearchFilter(id)}
              className={`giop-map-spotlight__filter-btn${active ? ' giop-map-spotlight__filter-btn--active' : ''}`}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          );
        })}
        <button
          type="button"
          title="Voice copilot — speak naturally, sends when you pause"
          aria-label={voiceActive ? 'Stop voice copilot' : 'Start voice copilot — speak naturally'}
          aria-pressed={voiceActive}
          onClick={voice.toggleMapVoice}
          className={`giop-map-spotlight__filter-btn giop-map-spotlight__voice-btn${
            voiceActive ? ' giop-map-spotlight__voice-btn--active' : ''
          }`}
        >
          <GiopTwistWaveCanvas
            className="giop-map-spotlight__voice-canvas"
            density={38}
            active={voiceActive}
          />
        </button>
        {!hideGeometryToggle && (
          <GiopNetworkGeometryToggle
            variant="inline"
            isLightMode={isLightMode}
            gisOverviewAvailable={gisOverviewAvailable}
            mode={networkGeometryMode}
            onModeChange={setNetworkGeometryMode}
          />
        )}
        {toolbarFilterOptions.slice(1).map(({ id, title, icon: Icon }) => {
          const active = filter === id;
          return (
            <button
              key={id}
              type="button"
              title={title}
              aria-label={title}
              aria-pressed={active}
              onClick={() => setSearchFilter(id)}
              className={`giop-map-spotlight__filter-btn${active ? ' giop-map-spotlight__filter-btn--active' : ''}`}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          );
        })}
      </div>

      {showPanel && (
        <div className="giop-map-spotlight__panel" id={listboxId} role="listbox">
          {busy && results.length === 0 && (
            <p className="giop-map-spotlight__empty">Looking up matches…</p>
          )}
          {!busy && results.length === 0 && (
            <p className="giop-map-spotlight__empty">No results for &ldquo;{query.trim()}&rdquo;</p>
          )}
          {results.map((result, index) => (
            <button
              key={resultKey(result)}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`giop-map-spotlight__result${
                index === activeIndex ? ' giop-map-spotlight__result--active' : ''
              }`}
              onMouseEnter={() => {
                confirmedRef.current = null;
                setActiveIndex(index);
                const key = resultKey(result);
                lastPreviewKeyRef.current = key;
                onPreview(result);
              }}
              onClick={() => pickResult(result)}
            >
              <span className="giop-map-spotlight__result-kind">{kindLabel(result)}</span>
              <span className="giop-map-spotlight__result-title">{result.title}</span>
              {result.subtitle && (
                <span className="giop-map-spotlight__result-sub">{result.subtitle}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
