import 'package:flutter/material.dart';

import '../models/asset_node.dart';

class LayerVisibility {
  LayerVisibility({
    this.onGrid = true,
    this.ownStaging = true,
    this.otherStaging = true,
    this.queuedLocal = true,
  });

  bool onGrid;
  bool ownStaging;
  bool otherStaging;
  bool queuedLocal;

  bool isVisible(MapNodeLayer layer) {
    switch (layer) {
      case MapNodeLayer.onGrid:
        return onGrid;
      case MapNodeLayer.ownStaging:
        return ownStaging;
      case MapNodeLayer.otherStaging:
        return otherStaging;
      case MapNodeLayer.queuedLocal:
        return queuedLocal;
    }
  }
}

String layerLabel(MapNodeLayer layer) {
  switch (layer) {
    case MapNodeLayer.onGrid:
      return 'Master grid';
    case MapNodeLayer.ownStaging:
      return 'Your staging';
    case MapNodeLayer.otherStaging:
      return 'Others staging';
    case MapNodeLayer.queuedLocal:
      return 'Queued offline';
  }
}

Color layerColor(MapNodeLayer layer) {
  switch (layer) {
    case MapNodeLayer.onGrid:
      return Colors.green;
    case MapNodeLayer.ownStaging:
      return Colors.orange;
    case MapNodeLayer.otherStaging:
      return Colors.purple;
    case MapNodeLayer.queuedLocal:
      return Colors.grey;
  }
}

IconData layerIcon(MapNodeLayer layer) {
  switch (layer) {
    case MapNodeLayer.onGrid:
      return Icons.electrical_services;
    case MapNodeLayer.ownStaging:
      return Icons.pending_actions;
    case MapNodeLayer.otherStaging:
      return Icons.group;
    case MapNodeLayer.queuedLocal:
      return Icons.cloud_off;
  }
}

class LayerPanelSheet extends StatelessWidget {
  const LayerPanelSheet({
    super.key,
    required this.visibility,
    required this.onChanged,
    required this.pendingCount,
    required this.onSync,
    required this.syncing,
    this.showWorkOrders = true,
    this.onShowWorkOrdersChanged,
    this.onOpenSyncQueue,
  });

  final LayerVisibility visibility;
  final VoidCallback onChanged;
  final int pendingCount;
  final VoidCallback onSync;
  final bool syncing;
  final bool showWorkOrders;
  final ValueChanged<bool>? onShowWorkOrdersChanged;
  final VoidCallback? onOpenSyncQueue;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                Text('Layers', style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                if (pendingCount > 0)
                  TextButton.icon(
                    onPressed: syncing ? null : onSync,
                    icon: syncing
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.sync, size: 18),
                    label: Text('Sync $pendingCount'),
                  ),
                if (onOpenSyncQueue != null)
                  TextButton.icon(
                    onPressed: onOpenSyncQueue,
                    icon: const Icon(Icons.cloud_upload_outlined, size: 18),
                    label: const Text('Queue'),
                  ),
              ],
            ),
          ),
          if (onShowWorkOrdersChanged != null)
            SwitchListTile(
              secondary: const Icon(Icons.assignment, color: Colors.indigo),
              title: const Text('Work order pins'),
              value: showWorkOrders,
              onChanged: (v) => onShowWorkOrdersChanged!(v),
            ),
          SwitchListTile(
            secondary: Icon(layerIcon(MapNodeLayer.onGrid), color: layerColor(MapNodeLayer.onGrid)),
            title: Text(layerLabel(MapNodeLayer.onGrid)),
            value: visibility.onGrid,
            onChanged: (v) {
              visibility.onGrid = v;
              onChanged();
            },
          ),
          SwitchListTile(
            secondary: Icon(layerIcon(MapNodeLayer.ownStaging), color: layerColor(MapNodeLayer.ownStaging)),
            title: Text(layerLabel(MapNodeLayer.ownStaging)),
            value: visibility.ownStaging,
            onChanged: (v) {
              visibility.ownStaging = v;
              onChanged();
            },
          ),
          SwitchListTile(
            secondary: Icon(layerIcon(MapNodeLayer.otherStaging), color: layerColor(MapNodeLayer.otherStaging)),
            title: Text(layerLabel(MapNodeLayer.otherStaging)),
            value: visibility.otherStaging,
            onChanged: (v) {
              visibility.otherStaging = v;
              onChanged();
            },
          ),
          SwitchListTile(
            secondary: Icon(layerIcon(MapNodeLayer.queuedLocal), color: layerColor(MapNodeLayer.queuedLocal)),
            title: Text(layerLabel(MapNodeLayer.queuedLocal)),
            value: visibility.queuedLocal,
            onChanged: (v) {
              visibility.queuedLocal = v;
              onChanged();
            },
          ),
        ],
      ),
    );
  }
}
