import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../services/giop_api.dart';
import '../services/offline_db.dart';

class CaptureScreen extends StatefulWidget {
  const CaptureScreen({super.key, required this.api});

  final GiopApi api;

  @override
  State<CaptureScreen> createState() => _CaptureScreenState();
}

class _CaptureScreenState extends State<CaptureScreen> {
  final _nameController = TextEditingController();
  Position? _position;
  String? _status;
  bool _loading = false;
  Map<String, dynamic>? _result;
  int _pendingOffline = 0;

  @override
  void initState() {
    super.initState();
    _syncPendingOffline();
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _syncPendingOffline() async {
    final pending = await OfflineDb.pendingCaptures();
    if (!mounted) return;
    setState(() => _pendingOffline = pending.length);

    for (final row in pending) {
      try {
        final result = await widget.api.submitFieldNode(
          name: row['name'] as String,
          longitude: (row['longitude'] as num).toDouble(),
          latitude: (row['latitude'] as num).toDouble(),
          mrid: row['mrid'] as String?,
          offlineSessionStartedAt:
              row['offline_session_started_at'] as String? ??
              DateTime.now().toUtc().toIso8601String(),
          operatorId: widget.api.operatorId,
        );
        if (result.conflict) {
          await OfflineDb.markCaptureConflicted(row['id'] as int);
          continue;
        }
        await OfflineDb.markCaptureSynced(
          row['id'] as int,
          result.mrid ?? 'unknown',
        );
      } catch (_) {
        break;
      }
    }
    final remaining = await OfflineDb.pendingCaptures();
    if (mounted) setState(() => _pendingOffline = remaining.length);
  }

  Future<void> _getLocation() async {
    setState(() {
      _loading = true;
      _status = 'Getting GPS…';
      _result = null;
    });
    try {
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        throw Exception('Location permission denied');
      }
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
        ),
      );
      setState(() {
        _position = pos;
        _status =
            'GPS: ${pos.latitude.toStringAsFixed(6)}, ${pos.longitude.toStringAsFixed(6)}';
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _status = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _submit() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      setState(() => _status = 'Enter a node name');
      return;
    }
    if (_position == null) {
      setState(() => _status = 'Capture GPS first');
      return;
    }

    setState(() {
      _loading = true;
      _status = 'Submitting…';
      _result = null;
    });
    try {
      final result = await widget.api.submitFieldNode(
        name: name,
        longitude: _position!.longitude,
        latitude: _position!.latitude,
        offlineSessionStartedAt: DateTime.now().toUtc().toIso8601String(),
        operatorId: widget.api.operatorId,
      );
      if (result.conflict) {
        setState(() {
          _status = result.message ?? 'Conflict — server record is newer';
          _loading = false;
        });
        return;
      }
      setState(() {
        _result = {'mrid': result.mrid, 'validation': 'PENDING_FIELD'};
        _status = 'Submitted — mrid ${result.mrid}';
        _loading = false;
      });
    } catch (e) {
      await OfflineDb.queueFieldCapture(
        name: name,
        longitude: _position!.longitude,
        latitude: _position!.latitude,
      );
      final pending = await OfflineDb.pendingCaptures();
      setState(() {
        _status =
            'Offline — queued locally (${pending.length} pending). Will sync when online.';
        _loading = false;
        _pendingOffline = pending.length;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Capture Asset')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _nameController,
            decoration: const InputDecoration(
              labelText: 'Node name',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _loading ? null : _getLocation,
            icon: const Icon(Icons.my_location),
            label: const Text('Get GPS location'),
          ),
          if (_position != null) ...[
            const SizedBox(height: 8),
            Text(
              'Lat: ${_position!.latitude.toStringAsFixed(6)}\n'
              'Lon: ${_position!.longitude.toStringAsFixed(6)}',
            ),
          ],
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _loading ? null : _submit,
            icon: const Icon(Icons.upload),
            label: const Text('Submit field node'),
          ),
          if (_pendingOffline > 0) ...[
            const SizedBox(height: 8),
            Text('$_pendingOffline capture(s) queued offline'),
            TextButton(onPressed: _syncPendingOffline, child: const Text('Sync now')),
          ],
          if (_status != null) ...[
            const SizedBox(height: 16),
            Text(_status!),
          ],
          if (_result != null) ...[
            const SizedBox(height: 16),
            Card(
              color: Colors.green.shade50,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Created', style: TextStyle(fontWeight: FontWeight.bold)),
                    Text('MRID: ${_result!['mrid']}'),
                    Text('Validation: ${_result!['validation']}'),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
