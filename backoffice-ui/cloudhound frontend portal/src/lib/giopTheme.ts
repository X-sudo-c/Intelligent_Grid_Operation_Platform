/**
 * Unified GIOP surface tokens — Cursor-inspired premium dark palette.
 * Use via giopThemeTokens(isLightMode) in tab components.
 */
export interface GiopThemeTokens {
  app: string;
  surface: string;
  card: string;
  cardInset: string;
  header: string;
  sidebar: string;
  border: string;
  borderSubtle: string;
  text: string;
  textSecondary: string;
  muted: string;
  mutedDim: string;
  input: string;
  btn: string;
  btnPrimary: string;
  hover: string;
  toolbar: string;
}

export function giopThemeTokens(isLightMode: boolean): GiopThemeTokens {
  if (isLightMode) {
    return {
      app: 'bg-slate-50 text-slate-900',
      surface: 'bg-white',
      card: 'border-slate-200/90 bg-white',
      cardInset: 'bg-slate-50/90 border-slate-200',
      header: 'border-slate-200 bg-white/95',
      sidebar: 'border-slate-200 bg-white',
      border: 'border-slate-200',
      borderSubtle: 'border-slate-200/80',
      text: 'text-slate-900',
      textSecondary: 'text-slate-700',
      muted: 'text-slate-500',
      mutedDim: 'text-slate-400',
      input: 'bg-white border-slate-200 text-slate-900',
      btn: 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
      btnPrimary: 'bg-cyan-600 hover:bg-cyan-500 text-white',
      hover: 'hover:bg-slate-100',
      toolbar: 'border-slate-200/90 bg-white/95',
    };
  }

  return {
    app: 'bg-premium-bg text-premium-text',
    surface: 'bg-premium-surface',
    card: 'border-premium-border/50 bg-premium-card',
    cardInset: 'bg-premium-surface border-premium-border/40',
    header: 'border-premium-border/50 bg-premium-sidebar/95',
    sidebar: 'border-premium-border/50 bg-premium-sidebar',
    border: 'border-premium-border/50',
    borderSubtle: 'border-premium-border/35',
    text: 'text-premium-text',
    textSecondary: 'text-premium-text-secondary',
    muted: 'text-premium-muted',
    mutedDim: 'text-premium-muted-dim',
    input: 'bg-premium-surface border-premium-border/50 text-premium-text',
    btn: 'border-premium-border/50 bg-premium-card text-premium-text-secondary hover:bg-premium-hover',
    btnPrimary:
      'border border-premium-accent/30 bg-premium-accent-subtle text-premium-text-secondary hover:border-premium-accent/45 hover:bg-premium-accent/15 hover:text-premium-text',
    hover: 'hover:bg-premium-hover',
    toolbar: 'border-premium-border/50 bg-premium-sidebar/95',
  };
}

/** Shorthand for the most common tab layout classes. */
export function giopTabChrome(isLightMode: boolean) {
  const t = giopThemeTokens(isLightMode);
  return {
    card: t.card,
    muted: t.muted,
    text: t.text,
    input: t.input,
    border: t.border,
  };
}
