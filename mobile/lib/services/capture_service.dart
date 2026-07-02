import 'dart:async';
import 'dart:io';

import '../models/asset_kind.dart';
import 'connectivity_service.dart';
import 'giop_api.dart';
import 'offline_db.dart';

class CaptureResult {
  const CaptureResult({
    required this.saved,
    this.synced = false,
    this.mrid,
    this.queued = false,
    this.conflict = false,
    this.message,
    this.localQueueId,
  });

  /// True when the capture is stored on device (always for a successful save).
  final bool saved;

  final bool synced;
  final String? mrid;
  final bool queued;
  final bool conflict;
  final String? message;
  final int? localQueueId;
}

class CaptureService {
  CaptureService(this.api);

  final GiopApi api;

  /// Global mutex — several CaptureService instances exist (map screen,
  /// FieldSyncService, capture screen) and per-item background uploads run
  /// alongside full queue drains. Serialize them so the same pending row is
  /// never uploaded twice.
  static Future<void> _syncLock = Future<void>.value();

  static Future<T> _locked<T>(Future<T> Function() action) async {
    final previous = _syncLock;
    final completer = Completer<void>();
    _syncLock = completer.future;
    try {
      await previous;
    } catch (_) {
      // A failed predecessor must not poison the lock chain.
    }
    try {
      return await action();
    } finally {
      completer.complete();
    }
  }

  /// Local-first: persist immediately, upload to staging in the background.
  Future<CaptureResult> submit({
    required String name,
    required double longitude,
    required double latitude,
    String operatingUtility = 'ECG_SOUTHERN',
    AssetKind assetKind = AssetKind.poleLv,
    String? substationName,
    String? boundaryFeederId,
    String? workOrderId,
    String? photoUrl,
    String? h3Index,
    bool enforceHexAssignment = false,
    String? recaptureMrid,
  }) async {
    final localId = await OfflineDb.queueFieldCapture(
      name: name,
      longitude: longitude,
      latitude: latitude,
      assetKind: assetKindToApiValue(assetKind),
      workOrderId: workOrderId,
      photoPath: _localPhotoPath(photoUrl),
      mrid: recaptureMrid,
      operatingUtility: operatingUtility,
      substationName: substationName,
      boundaryFeederId: boundaryFeederId,
      h3Index: h3Index,
      enforceHexAssignment: enforceHexAssignment,
    );

    final tempMrid = recaptureMrid ?? 'local:$localId';
    unawaited(_uploadCaptureInBackground(localId));

    return CaptureResult(
      saved: true,
      synced: false,
      queued: true,
      localQueueId: localId,
      mrid: tempMrid,
    );
  }

  Future<void> _uploadCaptureInBackground(int localId) async {
    if (!await ConnectivityService.instance.checkOnline()) return;
    await _locked(() async {
      // Re-read inside the lock: a concurrent full drain may have synced it.
      final row = await OfflineDb.getPendingCapture(localId);
      if (row == null) return;
      await _syncCaptureRow(row);
    });
  }

  /// Local-first span: save on device, upload in background.
  Future<bool> submitSpan({
    required String sourceNodeId,
    required String targetNodeId,
    String? boundaryFeederId,
    String? workOrderId,
    String? name,
  }) async {
    final queueId = await OfflineDb.queueFieldSpan(
      sourceNodeId: sourceNodeId,
      targetNodeId: targetNodeId,
      boundaryFeederId: boundaryFeederId,
      workOrderId: workOrderId,
      name: name,
    );
    unawaited(_uploadSpanInBackground(queueId));
    return true;
  }

  Future<void> _uploadSpanInBackground(int queueId) async {
    if (!await ConnectivityService.instance.checkOnline()) return;
    await _locked(() async {
      final rows = await OfflineDb.pendingSpans();
      for (final row in rows) {
        if (row['id'] == queueId) {
          await _syncSpanRow(row);
          return;
        }
      }
    });
  }

  Future<({bool synced, bool conflict, String? mrid, String? message})>
      _syncCaptureRow(Map<String, dynamic> row) async {
    final id = row['id'] as int;
    try {
      final photoUrl = await _resolvePhotoUrl(row['photo_path'] as String?);
      final result = await api.submitFieldNode(
        name: row['name'] as String,
        longitude: (row['longitude'] as num).toDouble(),
        latitude: (row['latitude'] as num).toDouble(),
        operatingUtility:
            row['operating_utility'] as String? ?? 'ECG_SOUTHERN',
        assetKind: assetKindFromString(row['asset_kind'] as String?),
        substationName: row['substation_name'] as String?,
        boundaryFeederId: row['boundary_feeder_id'] as String?,
        workOrderId: row['work_order_id'] as String?,
        photoUrl: photoUrl,
        h3Index: row['h3_index'] as String?,
        enforceHexAssignment: (row['enforce_hex_assignment'] as int? ?? 0) == 1,
        mrid: row['mrid'] as String?,
        offlineSessionStartedAt: row['offline_session_started_at'] as String? ??
            DateTime.now().toUtc().toIso8601String(),
        operatorId: api.operatorId,
      );
      if (result.conflict) {
        await OfflineDb.markCaptureConflicted(id);
        return (
          synced: false,
          conflict: true,
          mrid: result.mrid,
          message: result.message,
        );
      }
      await OfflineDb.markCaptureSynced(id, result.mrid ?? 'unknown');
      return (synced: true, conflict: false, mrid: result.mrid, message: null);
    } catch (e) {
      return (
        synced: false,
        conflict: false,
        mrid: null,
        message: e.toString(),
      );
    }
  }

  Future<bool> _syncSpanRow(Map<String, dynamic> row) async {
    final id = row['id'] as int;
    try {
      await api.submitFieldSpan(
        sourceNodeId: row['source_node_id'] as String,
        targetNodeId: row['target_node_id'] as String,
        boundaryFeederId: row['boundary_feeder_id'] as String?,
        workOrderId: row['work_order_id'] as String?,
        name: row['name'] as String?,
      );
      await OfflineDb.markSpanSynced(id);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<String?> _resolvePhotoUrl(String? photoPath) async {
    if (photoPath == null || photoPath.isEmpty) return null;
    if (photoPath.startsWith('http://') || photoPath.startsWith('https://')) {
      return photoPath;
    }
    final file = File(photoPath);
    if (!await file.exists()) return null;
    try {
      return await api.uploadFieldPhoto(file);
    } catch (_) {
      return null;
    }
  }

  String? _localPhotoPath(String? photoUrl) {
    if (photoUrl == null || photoUrl.isEmpty) return null;
    if (photoUrl.startsWith('http://') || photoUrl.startsWith('https://')) {
      return photoUrl;
    }
    return photoUrl;
  }

  Future<int> syncPending() async {
    final pending = await OfflineDb.pendingCaptures();
    var synced = 0;
    for (final row in pending) {
      final result = await _syncCaptureRow(row);
      if (result.conflict) continue;
      if (result.synced) {
        synced++;
        continue;
      }
      break;
    }

    final pendingSpans = await OfflineDb.pendingSpans();
    for (final row in pendingSpans) {
      final ok = await _syncSpanRow(row);
      if (ok) {
        synced++;
      } else {
        break;
      }
    }
    return synced;
  }

  Future<int> syncPendingSpotBills() async {
    final pending = await OfflineDb.pendingSpotBills();
    var synced = 0;
    for (final row in pending) {
      try {
        final previous = (row['previous_reading'] as num).toDouble();
        final current = (row['current_reading'] as num).toDouble();
        final tariff = OfflineDb.estimateTariffGhs(current - previous);
        String? photoUrl;
        final path = row['photo_path'] as String?;
        if (path != null && path.isNotEmpty) {
          photoUrl = await _resolvePhotoUrl(path);
        }
        await api.submitSpotBill(
          accountMrid: row['account_mrid'] as String,
          meterMrid: row['meter_mrid'] as String?,
          previousReadingKwh: previous,
          currentReadingKwh: current,
          evidencePhotoUrl: photoUrl,
          tariffRateGhs: tariff,
        );
        await OfflineDb.markSpotBillSynced(row['id'] as int);
        synced++;
      } catch (_) {
        break;
      }
    }
    return synced;
  }

  Future<int> syncPendingMeterReadings() async {
    final pending = await OfflineDb.pendingMeterReadings();
    var synced = 0;
    for (final row in pending) {
      try {
        await api.submitTelemetry(
          meterMrid: row['meter_mrid'] as String,
          activeEnergyKwh: (row['active_energy_kwh'] as num).toDouble(),
        );
        await OfflineDb.markMeterReadingSynced(row['id'] as int);
        synced++;
      } catch (_) {
        break;
      }
    }
    return synced;
  }

  Future<int> syncAllPending() async {
    if (!await ConnectivityService.instance.checkOnline()) return 0;
    return _locked(() async {
      final captures = await syncPending();
      final bills = await syncPendingSpotBills();
      final meters = await syncPendingMeterReadings();
      try {
        await api.syncWorkOrders();
      } catch (_) {
        // keep queued WO updates for next attempt
      }
      return captures + bills + meters;
    });
  }

  /// Queue locally; background upload when online.
  Future<bool> submitMeterReading({
    required String meterMrid,
    required double activeEnergyKwh,
    String? serialNumber,
    String? photoPath,
  }) async {
    final id = await OfflineDb.queueMeterReading(
      meterMrid: meterMrid,
      activeEnergyKwh: activeEnergyKwh,
      serialNumber: serialNumber,
      photoPath: photoPath,
    );
    unawaited(_uploadMeterReadingInBackground(id));
    return true;
  }

  Future<void> _uploadMeterReadingInBackground(int id) async {
    if (!await ConnectivityService.instance.checkOnline()) return;
    await _locked(() async {
      final rows = await OfflineDb.pendingMeterReadings();
      for (final row in rows) {
        if (row['id'] == id) {
          try {
            await api.submitTelemetry(
              meterMrid: row['meter_mrid'] as String,
              activeEnergyKwh: (row['active_energy_kwh'] as num).toDouble(),
            );
            await OfflineDb.markMeterReadingSynced(id);
          } catch (_) {}
          return;
        }
      }
    });
  }
}
