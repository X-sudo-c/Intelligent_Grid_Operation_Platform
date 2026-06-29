# Premium Animation Integration Guide

This guide shows how to integrate the new premium animated components into the existing GIOP Portal.

## Quick Start

### 1. Replace PortalShell with EnhancedPortalShell

```tsx
// Before (in App.tsx or GiopPortal.tsx):
import { PortalShell } from './components/PortalShell';

// After:
import { EnhancedPortalShell } from './components/EnhancedPortalShell';

// Usage - same props, enhanced animations:
<EnhancedPortalShell
  activeTab={activeTab}
  onTabChange={setActiveTab}
  isLightMode={isLightMode}
  onToggleTheme={toggleTheme}
  title="Operations"
  subtitle="Staging asset management"
  navGroups={navGroups}
>
  {content}
</EnhancedPortalShell>
```

**Enhancements:**
- Sliding active tab indicator (purple bar)
- Spring-animated badge counts with pulse effect
- Staggered entrance animations for nav items
- Smooth page transitions when switching tabs
- Rotating theme toggle icon

---

### 2. Replace Toast with AnimatedToast

```tsx
// Before:
import { useToasts, ToastStack } from './components/Toast';

// After:
import { useAnimatedToasts, AnimatedToastStack } from './components/AnimatedToast';

// Usage - same API, enhanced animations:
function MyComponent() {
  const { toasts, showToast, dismissToast } = useAnimatedToasts();
  
  return (
    <>
      <button onClick={() => showToast('Success!', 'success')}>
        Show Toast
      </button>
      <AnimatedToastStack 
        toasts={toasts} 
        onDismiss={dismissToast} 
        isLightMode={isLightMode}
      />
    </>
  );
}
```

**New toast type:**
```tsx
// Premium toast with amber gradient glow
showToast('Field trial backup complete', 'premium');
```

**Enhancements:**
- Slide + scale entrance animation
- Bouncing icon entrance
- Staggered stacking for multiple toasts
- Gradient glow for premium toasts
- Smooth exit animation

---

### 3. Replace CopilotPanel with EnhancedCopilotPanel

```tsx
// Before:
import { GiopCopilotPanel } from './components/GiopCopilotPanel';

// After:
import { EnhancedCopilotPanel } from './components/EnhancedCopilotPanel';

// Usage - same props:
<EnhancedCopilotPanel
  isLightMode={isLightMode}
  portalContext={context}
  onUiAction={handleAction}
/>
```

**Enhancements:**
- Smooth slide-up panel animation
- Pulsing FAB button with glow
- Staggered message entrance animations
- Typing indicator with bouncing dots
- Recording pulse ring effect
- Spring-animated send button
- Gradient header with animated sparkles

---

### 4. Use PremiumCard for Metric Cards

```tsx
import { PremiumCard, PremiumMetricCard, StatCard } from './components/PremiumCard';

// Individual metric card with trend:
<PremiumMetricCard
  label="Total Assets"
  value={12_450}
  trend="up"
  trendValue="+12% vs last week"
  isLightMode={isLightMode}
  icon={<Database className="h-5 w-5" />}
  color="success"
/>

// Stat card with progress bar:
<StatCard
  title="Topology Validity"
  value={94.5}
  max={100}
  isLightMode={isLightMode}
/>

// Generic premium card with hover effect:
<PremiumCard
  isLightMode={isLightMode}
  variant="glass"  // or 'default', 'elevated', 'glow'
  hoverEffect="lift"  // or 'glow', 'scale', 'none'
>
  <h3>Content</h3>
</PremiumCard>
```

**Enhancements:**
- 3D lift hover effect with shadow
- Glass morphism variant with backdrop blur
- Animated value entrance
- Animated progress bar fill
- Glow variant for featured content

---

### 5. Use AnimatedBadge for Status Indicators

```tsx
import { AnimatedBadge, StatusIndicator, LiveIndicator } from './components/AnimatedBadge';

// Notification badge with spring animation:
<AnimatedBadge 
  count={42} 
  isLightMode={isLightMode}
  pulse  // Optional pulse ring
/>

// Status indicator with pulse:
<StatusIndicator 
  status="online"  // 'online' | 'offline' | 'busy' | 'warning' | 'error'
  pulse  // Animated pulse ring
/>

// Live/recording indicator:
<LiveIndicator isLive label="REC" />
```

**Enhancements:**
- Spring entrance animation for count changes
- Ring pulse effect for active/important states
- Color-coded status dots with animated rings
- Double-pulse live indicator

---

### 6. Use AnimatedDataTable for Tables

```tsx
import { AnimatedDataTable, AnimatedActionButton } from './components/AnimatedDataTable';

<AnimatedDataTable
  data={assets}
  columns={[
    { key: 'name', header: 'Name', sortable: true },
    { 
      key: 'status', 
      header: 'Status',
      render: (row) => <Badge>{row.status}</Badge>
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <AnimatedActionButton
          onClick={() => handleAction(row)}
          variant="primary"
          isLightMode={isLightMode}
        >
          Action
        </AnimatedActionButton>
      ),
    },
  ]}
  keyExtractor={(row) => row.id}
  isLightMode={isLightMode}
  onRowClick={(row) => console.log(row)}
  isLoading={loading}
/>
```

**Enhancements:**
- Staggered row entrance animations
- Animated sort indicators
- Smooth row hover effect with slight shift
- Loading skeleton state
- Animated empty state with floating icon

---

### 7. Use AnimatedModal for Modals

```tsx
import { AnimatedModal, ConfirmModal } from './components/AnimatedModal';

// Generic animated modal:
<AnimatedModal
  open={isOpen}
  onClose={close}
  title="Validation Run"
  isLightMode={isLightMode}
  size="lg"  // 'sm' | 'md' | 'lg' | 'xl' | 'full'
  footer={
    <button onClick={close}>Close</button>
  }
>
  <p>Modal content with scale + fade animation</p>
</AnimatedModal>

// Confirm modal with loading state:
<ConfirmModal
  open={confirmOpen}
  onClose={closeConfirm}
  onConfirm={handleConfirm}
  message="Are you sure you want to delete this asset?"
  confirmLabel="Delete"
  variant="danger"  // 'danger' | 'warning' | 'info'
  isLoading={deleting}
  isLightMode={isLightMode}
/>
```

**Enhancements:**
- Backdrop blur + fade animation
- Content scale + fade entrance
- Rotating close button hover
- Loading spinner in confirm button
- Body scroll lock when open

---

### 8. Use AnimatedSkeleton for Loading States

```tsx
import { 
  AnimatedSkeleton, 
  MetricCardSkeleton, 
  TableRowSkeleton 
} from './components/AnimatedSkeleton';

// Basic shimmer skeleton:
<AnimatedSkeleton 
  variant="card"  // 'default' | 'card' | 'text' | 'avatar' | 'metric'
  isLightMode={isLightMode}
  className="h-32"
/>

// Full card skeleton:
<MetricCardSkeleton isLightMode={isLightMode} />

// Table row skeletons:
<TableRowSkeleton isLightMode={isLightMode} columns={4} />
```

**Enhancements:**
- Shimmer/gradient sweep animation
- Multiple variants for common patterns
- Staggered entrance for skeleton groups

---

## CSS Utilities Added

New utility classes in `index.css`:

```css
/* Glass morphism */
.glass, .glass-dark, .glass-light

/* Glow effects */
.glow-indigo, .glow-emerald, .glow-amber, .glow-cyan

/* Shimmer loading */
.shimmer

/* Gradient border */
.gradient-border

/* Card lift hover */
.card-lift

/* Loading dots */
.loading-dots

/* Pulse ring */
.pulse-ring

/* Text gradients */
.text-gradient, .text-gradient-amber

/* Focus ring animation */
.focus-ring-animate

/* Stagger children */
.stagger-children
```

---

## Motion Presets

Import from `lib/motion.ts`:

```tsx
import { 
  ease,  // Cubic bezier curves
  duration,  // Duration presets
  staggerContainer,  // Stagger animation container
  fadeUpItem,  // Fade up item variant
  slideUp,  // Slide up variant
  scaleFade,  // Scale + fade variant
  card3D,  // 3D hover effect
} from './lib/motion';
```

---

## Accessibility

All animations respect `prefers-reduced-motion`:
- CSS animations disable when reduced motion is preferred
- Framer Motion supports reduced motion automatically
- Skeletons fall back to static placeholders
- No animation delays on critical UI

---

## Performance Notes

- Framer Motion uses hardware-accelerated transforms
- `layout` prop animates layout changes smoothly
- `AnimatePresence` handles mount/unmount animations
- All components use `will-change: transform` appropriately
- No animations block user interactions
