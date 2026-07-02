import 'package:flutter/material.dart';

import '../models/sync_queue_item.dart';
import '../services/field_sync_service.dart';
import '../services/giop_api.dart';
import '../services/offline_db.dart';

/// Pending local uploads; pushes to staging when online.
class SyncQueueScreen extends StatefulWidget {
  const SyncQueueScreen({
    super.key,
    required this.api,
    this.fieldSync,
  });

  final GiopApi api;
  final FieldSyncService? fieldSync;

  @override
  State<SyncQueueScreen> createState() => _SyncQueueScreenState();
}

class _SyncQueueScreenState extends State<SyncQueueScreen> {
  late final FieldSyncService _fieldSync;
  List<SyncQueueItem> _items = const [];
  bool _loading = true;
  bool _syncing = false;
  String? _message;

  @override
  void initState() {
    super.initState();
    _fieldSync = widget.fieldSync ?? FieldSyncService(widget.api);
    _reload();
  }

  Future<void> _reload() async {
    setState(() => _loading = true);
    final items = await OfflineDb.listSyncQueueItems();
    if (!mounted) return;
    setState(() {
      _items = items;
      _loading = false;
    });
  }

  Future<void> _syncAll() async {
    setState(() {
      _syncing = true;
      _message = null;
    });
    try {
      final n = await _fieldSync.syncAll();
      if (!mounted) return;
      setState(() => _message = n > 0 ? 'Uploaded $n item(s) to staging' : 'Nothing to upload');
      await _reload();
    } catch (e) {
      if (mounted) setState(() => _message = 'Sync error: $e');
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pending = _items.where((i) => i.isPending).length;
    final conflicts = _items.where((i) => i.isConflicted).length;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Sync queue'),
        actions: [
          IconButton(
            icon: _syncing
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.sync),
            onPressed: _syncing ? null : _syncAll,
            tooltip: 'Upload to staging',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                if (_message != null)
                  MaterialBanner(
                    content: Text(_message!),
                    actions: [
                      TextButton(
                        onPressed: () => setState(() => _message = null),
                        child: const Text('OK'),
                      ),
                    ],
                  ),
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    pending == 0 && conflicts == 0
                        ? 'All caught up — nothing waiting on this device.'
                        : '$pending saved locally · $conflicts need review',
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                ),
                Expanded(
                  child: _items.isEmpty
                      ? const Center(
                          child: Text(
                            'Captures, spans, meter readings, and work-order\n'
                            'updates are stored here until uploaded.',
                            textAlign: TextAlign.center,
                          ),
                        )
                      : ListView.builder(
                          itemCount: _items.length,
                          itemBuilder: (context, i) {
                            final item = _items[i];
                            return ListTile(
                              leading: Icon(_iconFor(item.kind)),
                              title: Text(item.title),
                              subtitle: Text(
                                [
                                  item.kind,
                                  if (item.detail != null) item.detail!,
                                  item.status,
                                ].join(' · '),
                              ),
                            );
                          },
                        ),
                ),
              ],
            ),
    );
  }

  IconData _iconFor(String kind) => switch (kind) {
        'capture' => Icons.add_location_alt,
        'span' => Icons.linear_scale,
        'spot_bill' => Icons.receipt_long,
        'meter' => Icons.speed,
        'work_order' => Icons.assignment,
        _ => Icons.cloud_upload,
      };
}
