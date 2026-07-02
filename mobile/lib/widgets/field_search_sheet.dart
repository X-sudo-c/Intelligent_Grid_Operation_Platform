import 'package:flutter/material.dart';

import '../models/asset_node.dart';
import '../services/field_map_fly_bus.dart';
import '../services/offline_db.dart';

/// Offline-first asset search (cached nodes + pending captures).
class FieldSearchSheet extends StatefulWidget {
  const FieldSearchSheet({super.key});

  static Future<void> show(BuildContext context) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: const FieldSearchSheet(),
      ),
    );
  }

  @override
  State<FieldSearchSheet> createState() => _FieldSearchSheetState();
}

class _FieldSearchSheetState extends State<FieldSearchSheet> {
  final _controller = TextEditingController();
  List<AssetNode> _results = const [];
  bool _loading = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _search(String query) async {
    setState(() => _loading = true);
    final rows = await OfflineDb.searchCachedNodes(query);
    if (!mounted) return;
    setState(() {
      _results = rows;
      _loading = false;
    });
  }

  void _open(AssetNode node) {
    if (!node.hasCoordinates) return;
    FieldMapFlyBus.instance.flyTo(
      latitude: node.latitude!,
      longitude: node.longitude!,
      label: node.name,
    );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Find asset', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            TextField(
              controller: _controller,
              autofocus: true,
              decoration: const InputDecoration(
                hintText: 'Name or MRID',
                prefixIcon: Icon(Icons.search),
                border: OutlineInputBorder(),
              ),
              onChanged: (v) => _search(v.trim()),
            ),
            const SizedBox(height: 8),
            if (_loading) const LinearProgressIndicator(minHeight: 2),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: _results.length,
                itemBuilder: (context, index) {
                  final node = _results[index];
                  return ListTile(
                    leading: const Icon(Icons.place_outlined),
                    title: Text(node.name),
                    subtitle: Text(
                      '${node.mrid} · ${node.validation}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    onTap: () => _open(node),
                  );
                },
              ),
            ),
            if (!_loading && _controller.text.isNotEmpty && _results.isEmpty)
              const Padding(
                padding: EdgeInsets.all(12),
                child: Text('No cached matches. Pan the map to load more nodes.'),
              ),
          ],
        ),
      ),
    );
  }
}
