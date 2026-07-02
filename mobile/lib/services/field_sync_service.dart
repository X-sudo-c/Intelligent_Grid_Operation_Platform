import 'dart:async';

import 'capture_service.dart';
import 'connectivity_service.dart';
import 'giop_api.dart';

/// Orchestrates offline queue → staging upload when the device is online.
class FieldSyncService {
  FieldSyncService(this.api) : _captureService = CaptureService(api);

  final GiopApi api;
  final CaptureService _captureService;
  bool _syncing = false;
  StreamSubscription<bool>? _connectivitySub;

  CaptureService get captureService => _captureService;

  bool get isSyncing => _syncing;

  /// Start listening for connectivity; auto-upload when back online.
  Future<void> start({bool autoSyncOnConnect = true}) async {
    await ConnectivityService.instance.start();
    await _connectivitySub?.cancel();
    if (await ConnectivityService.instance.checkOnline()) {
      unawaited(syncAll());
    }
    if (!autoSyncOnConnect) return;
    _connectivitySub =
        ConnectivityService.instance.onlineStream.listen((online) {
      if (online) {
        unawaited(syncAll());
      }
    });
  }

  void dispose() {
    _connectivitySub?.cancel();
  }

  /// Push all pending local rows to staging (captures, spans, bills, meters, WOs).
  Future<int> syncAll() async {
    if (_syncing) return 0;
    _syncing = true;
    try {
      return await _captureService.syncAllPending();
    } finally {
      _syncing = false;
    }
  }
}
