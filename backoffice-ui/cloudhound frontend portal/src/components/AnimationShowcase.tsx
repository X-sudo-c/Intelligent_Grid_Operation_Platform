/**
 * Animation Showcase Component
 * 
 * A demonstration of all premium animations available in the GIOP Portal.
 * Use this to preview and test animation effects.
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { 
  Sparkles, 
  Database, 
  AlertCircle, 
  CheckCircle,
  Activity
} from 'lucide-react';
import { 
  PremiumCard, 
  PremiumMetricCard, 
  StatCard 
} from './PremiumCard';
import { 
  AnimatedBadge, 
  StatusIndicator, 
  LiveIndicator 
} from './AnimatedBadge';
import { 
  AnimatedModal, 
  ConfirmModal 
} from './AnimatedModal';
import { 
  AnimatedDataTable, 
  AnimatedActionButton 
} from './AnimatedDataTable';
import { 
  useAnimatedToasts, 
  AnimatedToastStack 
} from './AnimatedToast';
import {
  MetricCardSkeleton,
  TableRowSkeleton
} from './AnimatedSkeleton';
import { staggerContainer, fadeUpItem } from '../lib/motion';

interface ShowcaseProps {
  isLightMode?: boolean;
}

export function AnimationShowcase({ isLightMode = false }: ShowcaseProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toasts, showToast, dismissToast } = useAnimatedToasts();

  const showAllToasts = () => {
    showToast('Operation completed successfully', 'success');
    setTimeout(() => showToast('Warning: Connection unstable', 'error'), 300);
    setTimeout(() => showToast('New data available', 'info'), 600);
    setTimeout(() => showToast('Premium feature activated', 'premium'), 900);
  };

  const triggerLoading = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 3000);
  };

  const tableData = [
    { id: '1', name: 'Transformer T-101', status: 'active', voltage: '11kV', district: 'Accra' },
    { id: '2', name: 'Line L-203', status: 'maintenance', voltage: '33kV', district: 'Kumasi' },
    { id: '3', name: 'Pole P-456', status: 'active', voltage: 'LV', district: 'Tema' },
    { id: '4', name: 'Substation S-12', status: 'offline', voltage: '132kV', district: 'Tamale' },
  ];

  return (
    <div className={`min-h-screen p-8 ${isLightMode ? 'bg-slate-50' : 'bg-premium-bg'}`}>
      <AnimatedToastStack toasts={toasts} onDismiss={dismissToast} isLightMode={isLightMode} />

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8"
      >
        <h1 className={`text-3xl font-bold mb-2 ${isLightMode ? 'text-slate-900' : 'text-white'}`}>
          <span className="text-gradient">Premium</span> Animation Showcase
        </h1>
        <p className={`${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>
          Modern, high-end UI components with smooth animations
        </p>
      </motion.div>

      {/* Section: Badges & Indicators */}
      <motion.section
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="mb-12"
      >
        <h2 className={`text-xl font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
          Badges & Indicators
        </h2>
        <div className="flex flex-wrap items-center gap-6">
          <motion.div variants={fadeUpItem} className="flex items-center gap-3">
            <span className={`text-sm ${isLightMode ? 'text-slate-600' : 'text-slate-400'}`}>Badge:</span>
            <AnimatedBadge count={42} isLightMode={isLightMode} pulse />
          </motion.div>

          <motion.div variants={fadeUpItem} className="flex items-center gap-3">
            <span className={`text-sm ${isLightMode ? 'text-slate-600' : 'text-slate-400'}`}>Online:</span>
            <StatusIndicator status="online" pulse />
          </motion.div>

          <motion.div variants={fadeUpItem} className="flex items-center gap-3">
            <span className={`text-sm ${isLightMode ? 'text-slate-600' : 'text-slate-400'}`}>Busy:</span>
            <StatusIndicator status="busy" pulse />
          </motion.div>

          <motion.div variants={fadeUpItem} className="flex items-center gap-3">
            <span className={`text-sm ${isLightMode ? 'text-slate-600' : 'text-slate-400'}`}>Live:</span>
            <LiveIndicator isLive label="LIVE" />
          </motion.div>
        </div>
      </motion.section>

      {/* Section: Metric Cards */}
      <motion.section
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="mb-12"
      >
        <h2 className={`text-xl font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
          Premium Metric Cards
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <motion.div variants={fadeUpItem}>
            <PremiumMetricCard
              label="Total Assets"
              value={12_450}
              trend="up"
              trendValue="+12%"
              isLightMode={isLightMode}
              icon={<Database className="h-5 w-5 text-indigo-500" />}
              color="default"
            />
          </motion.div>

          <motion.div variants={fadeUpItem}>
            <PremiumMetricCard
              label="Topology Valid"
              value="94.5%"
              trend="up"
              trendValue="+2.3%"
              isLightMode={isLightMode}
              icon={<CheckCircle className="h-5 w-5 text-emerald-500" />}
              color="success"
            />
          </motion.div>

          <motion.div variants={fadeUpItem}>
            <PremiumMetricCard
              label="Active Alerts"
              value={23}
              trend="down"
              trendValue="-5"
              isLightMode={isLightMode}
              icon={<AlertCircle className="h-5 w-5 text-amber-500" />}
              color="warning"
            />
          </motion.div>

          <motion.div variants={fadeUpItem}>
            <StatCard
              title="Grid Coverage"
              value={87}
              max={100}
              isLightMode={isLightMode}
            />
          </motion.div>
        </div>
      </motion.section>

      {/* Section: Card Variants */}
      <motion.section
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="mb-12"
      >
        <h2 className={`text-xl font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
          Card Variants
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <motion.div variants={fadeUpItem}>
            <PremiumCard isLightMode={isLightMode} variant="default" hoverEffect="lift">
              <div className="p-4">
                <h3 className={`font-medium mb-2 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>Default</h3>
                <p className={`text-sm ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>Lift hover effect</p>
              </div>
            </PremiumCard>
          </motion.div>

          <motion.div variants={fadeUpItem}>
            <PremiumCard isLightMode={isLightMode} variant="glass" hoverEffect="glow">
              <div className="p-4">
                <h3 className={`font-medium mb-2 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>Glass</h3>
                <p className={`text-sm ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>Backdrop blur</p>
              </div>
            </PremiumCard>
          </motion.div>

          <motion.div variants={fadeUpItem}>
            <PremiumCard isLightMode={isLightMode} variant="elevated" hoverEffect="scale">
              <div className="p-4">
                <h3 className={`font-medium mb-2 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>Elevated</h3>
                <p className={`text-sm ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>Scale on hover</p>
              </div>
            </PremiumCard>
          </motion.div>

          <motion.div variants={fadeUpItem}>
            <PremiumCard isLightMode={isLightMode} variant="glow" hoverEffect="lift">
              <div className="p-4">
                <h3 className={`font-medium mb-2 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>Glow</h3>
                <p className={`text-sm ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>Purple glow effect</p>
              </div>
            </PremiumCard>
          </motion.div>
        </div>
      </motion.section>

      {/* Section: Actions */}
      <motion.section
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="mb-12"
      >
        <h2 className={`text-xl font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
          Buttons & Actions
        </h2>
        <div className="flex flex-wrap gap-3">
          <motion.div variants={fadeUpItem}>
            <AnimatedActionButton
              onClick={showAllToasts}
              variant="primary"
              isLightMode={isLightMode}
            >
              <Sparkles className="h-4 w-4" />
              Show Toasts
            </AnimatedActionButton>
          </motion.div>

          <motion.div variants={fadeUpItem}>
            <AnimatedActionButton
              onClick={() => setModalOpen(true)}
              variant="secondary"
              isLightMode={isLightMode}
            >
              <Activity className="h-4 w-4" />
              Open Modal
            </AnimatedActionButton>
          </motion.div>

          <motion.div variants={fadeUpItem}>
            <AnimatedActionButton
              onClick={() => setConfirmOpen(true)}
              variant="danger"
              isLightMode={isLightMode}
            >
              <AlertCircle className="h-4 w-4" />
              Confirm Dialog
            </AnimatedActionButton>
          </motion.div>

          <motion.div variants={fadeUpItem}>
            <AnimatedActionButton
              onClick={triggerLoading}
              variant="primary"
              isLoading={loading}
              isLightMode={isLightMode}
            >
              {loading ? 'Loading...' : 'Loading State'}
            </AnimatedActionButton>
          </motion.div>
        </div>
      </motion.section>

      {/* Section: Data Table */}
      <motion.section
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="mb-12"
      >
        <h2 className={`text-xl font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
          Animated Data Table
        </h2>
        <motion.div variants={fadeUpItem}>
          <AnimatedDataTable
            data={tableData}
            columns={[
              { key: 'name', header: 'Asset Name', sortable: true },
              { 
                key: 'status', 
                header: 'Status',
                render: (row) => (
                  <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                    row.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                    row.status === 'maintenance' ? 'bg-amber-100 text-amber-700' :
                    'bg-rose-100 text-rose-700'
                  }`}>
                    {row.status}
                  </span>
                )
              },
              { key: 'voltage', header: 'Voltage', sortable: true },
              { key: 'district', header: 'District', sortable: true },
              {
                key: 'actions',
                header: '',
                render: () => (
                  <AnimatedActionButton
                    onClick={() => {}}
                    variant="ghost"
                    size="sm"
                    isLightMode={isLightMode}
                  >
                    View
                  </AnimatedActionButton>
                ),
              },
            ]}
            keyExtractor={(row) => row.id}
            isLightMode={isLightMode}
          />
        </motion.div>
      </motion.section>

      {/* Section: Loading Skeletons */}
      <motion.section
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="mb-12"
      >
        <h2 className={`text-xl font-semibold mb-4 ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
          Loading Skeletons
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <motion.div variants={fadeUpItem}>
            <MetricCardSkeleton isLightMode={isLightMode} />
          </motion.div>
          <motion.div variants={fadeUpItem} className="col-span-2">
            <div className={`p-4 rounded-xl border ${isLightMode ? 'bg-white border-slate-200' : 'bg-premium-card border-premium-border/70'}`}>
              <TableRowSkeleton isLightMode={isLightMode} columns={3} />
              <TableRowSkeleton isLightMode={isLightMode} columns={3} />
              <TableRowSkeleton isLightMode={isLightMode} columns={3} />
            </div>
          </motion.div>
        </div>
      </motion.section>

      {/* Modals */}
      <AnimatedModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Animated Modal"
        isLightMode={isLightMode}
        footer={
          <AnimatedActionButton
            onClick={() => setModalOpen(false)}
            variant="secondary"
            isLightMode={isLightMode}
          >
            Close
          </AnimatedActionButton>
        }
      >
        <p className={isLightMode ? 'text-slate-600' : 'text-premium-text-secondary'}>
          This modal features a backdrop blur effect, scale entrance animation, 
          and smooth exit transitions. Try hovering over the close button!
        </p>
      </AnimatedModal>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setTimeout(() => setConfirmOpen(false), 1000);
        }}
        message="This demonstrates a confirmation dialog with animated loading state on the confirm button."
        confirmLabel="Confirm Action"
        variant="warning"
        isLightMode={isLightMode}
      />
    </div>
  );
}
