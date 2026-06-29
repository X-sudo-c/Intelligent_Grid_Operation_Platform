import 'package:flutter/material.dart';

import '../services/giop_api.dart';
import '../services/offline_db.dart';

class WorkOrdersScreen extends StatefulWidget {
  const WorkOrdersScreen({super.key, required this.api});

  final GiopApi api;

  @override
  State<WorkOrdersScreen> createState() => _WorkOrdersScreenState();
}

class _WorkOrdersScreenState extends State<WorkOrdersScreen>
    with WidgetsBindingObserver {
  List<Map<String, dynamic>> _orders = [];
  List<TechnicianSubmission> _rejected = [];
  bool _loading = true;
  String? _status;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _sync();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _sync();
    }
  }

  Future<void> _sync() async {
    setState(() {
      _loading = true;
      _status = null;
    });
    List<TechnicianSubmission> rejected = const [];
    try {
      rejected = (await widget.api.fetchMySubmissions())
          .where((s) => s.validation == 'REJECTED')
          .toList();
    } catch (_) {
      // submissions are optional when offline
    }
    try {
      await widget.api.syncWorkOrders();
      final local = await OfflineDb.listWorkOrders();
      setState(() {
        _orders = local;
        _rejected = rejected;
        _loading = false;
      });
    } catch (e) {
      final local = await OfflineDb.listWorkOrders();
      setState(() {
        _orders = local;
        _rejected = rejected;
        _loading = false;
        _status = 'Offline — showing cached work orders';
      });
    }
  }

  Future<void> _advanceStatus(String id, String current) async {
    const next = {
      'DISPATCHED': 'RECEIVED',
      'RECEIVED': 'ACCEPTED',
      'ACCEPTED': 'EN_ROUTE',
      'EN_ROUTE': 'ON_SITE',
      'ON_SITE': 'IN_PROGRESS',
      'IN_PROGRESS': 'COMPLETED',
    };
    final newStatus = next[current];
    if (newStatus == null) return;
    await OfflineDb.queueWorkOrderStatusUpdate(
      workOrderId: id,
      newStatus: newStatus,
    );
    setState(() {
      _status = 'Status queued — syncing…';
    });
    await _sync();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Work Orders'),
        actions: [
          IconButton(
            icon: const Icon(Icons.sync),
            onPressed: _loading ? null : () => _sync(),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _sync,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_status != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(_status!, style: Theme.of(context).textTheme.bodySmall),
                    ),
                  if (_rejected.isNotEmpty) ...[
                    Text(
                      'Rejected captures',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    ..._rejected.map((item) {
                      final reason = _rejectionReason(item.errorLog);
                      return Card(
                        color: Theme.of(context).colorScheme.errorContainer.withValues(alpha: 0.35),
                        child: ListTile(
                          leading: Icon(
                            Icons.warning_amber_rounded,
                            color: Theme.of(context).colorScheme.error,
                          ),
                          title: Text(item.name.isNotEmpty ? item.name : item.mrid),
                          subtitle: Text(
                            reason ?? 'Rejected by backoffice — recapture from the map.',
                          ),
                          isThreeLine: reason != null,
                        ),
                      );
                    }),
                    const SizedBox(height: 16),
                    Text(
                      'Work orders',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                  ],
                  if (_orders.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('No assigned work orders.'),
                    ),
                  ..._orders.map((wo) {
                    final id = wo['id'] as String;
                    final status = wo['status'] as String? ?? 'DISPATCHED';
                    return Card(
                      child: ListTile(
                        title: Text(wo['reference'] as String? ?? id),
                        subtitle: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const SizedBox(height: 4),
                            Text(wo['summary'] as String? ?? ''),
                            const SizedBox(height: 4),
                            Text(
                              '${wo['work_type']} · $status',
                              style: Theme.of(context).textTheme.labelSmall,
                            ),
                          ],
                        ),
                        isThreeLine: true,
                        trailing: status != 'COMPLETED' && status != 'CANCELLED'
                            ? TextButton(
                                onPressed: () => _advanceStatus(id, status),
                                child: const Text('Advance'),
                              )
                            : null,
                      ),
                    );
                  }),
                ],
              ),
            ),
    );
  }

  String? _rejectionReason(String? errorLog) {
    if (errorLog == null || errorLog.isEmpty) return null;
    final lines = errorLog.split('\n').where((l) => l.contains('REJECTED:')).toList();
    if (lines.isEmpty) return errorLog.trim();
    return lines.last.replaceFirst(RegExp(r'.*REJECTED:\s*'), '').trim();
  }
}
