import '../models/asset_kind.dart';
import '../services/giop_api.dart';
import '../services/offline_db.dart';

class CaptureResult {
  const CaptureResult({
    required this.synced,
    this.mrid,
    this.queued = false,
    this.conflict = false,
    this.message,
  });

  final bool synced;
  final String? mrid;
  final bool queued;
  final bool conflict;
  final String? message;
}

class CaptureService {
  CaptureService(this.api);

  final GiopApi api;

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
    try {
      final result = await api.submitFieldNode(
        name: name,
        longitude: longitude,
        latitude: latitude,
        operatingUtility: operatingUtility,
        assetKind: assetKind,
        substationName: substationName,
        boundaryFeederId: boundaryFeederId,
        workOrderId: workOrderId,
        photoUrl: photoUrl,
        h3Index: h3Index,
        enforceHexAssignment: enforceHexAssignment,
        mrid: recaptureMrid,
        offlineSessionStartedAt: DateTime.now().toUtc().toIso8601String(),
        operatorId: api.operatorId,
      );
      if (result.conflict) {
        return CaptureResult(
          synced: false,
          conflict: true,
          mrid: result.mrid,
          message: result.message,
        );
      }
      return CaptureResult(synced: true, mrid: result.mrid);
    } catch (e) {
      await OfflineDb.queueFieldCapture(
        name: name,
        longitude: longitude,
        latitude: latitude,
        assetKind: assetKindToApiValue(assetKind),
        workOrderId: workOrderId,
        photoPath: photoUrl,
        mrid: recaptureMrid,
      );
      return CaptureResult(synced: false, queued: true, message: e.toString());
    }
  }

  Future<bool> submitSpan({
    required String sourceNodeId,
    required String targetNodeId,
    String? boundaryFeederId,
    String? workOrderId,
    String? name,
  }) async {
    try {
      await api.submitFieldSpan(
        sourceNodeId: sourceNodeId,
        targetNodeId: targetNodeId,
        boundaryFeederId: boundaryFeederId,
        workOrderId: workOrderId,
        name: name,
      );
      return true;
    } catch (_) {
      await OfflineDb.queueFieldSpan(
        sourceNodeId: sourceNodeId,
        targetNodeId: targetNodeId,
        boundaryFeederId: boundaryFeederId,
        workOrderId: workOrderId,
        name: name,
      );
      return false;
    }
  }

  Future<int> syncPending() async {
    final pending = await OfflineDb.pendingCaptures();
    var synced = 0;
    for (final row in pending) {
      try {
        final result = await api.submitFieldNode(
          name: row['name'] as String,
          longitude: (row['longitude'] as num).toDouble(),
          latitude: (row['latitude'] as num).toDouble(),
          assetKind: assetKindFromString(row['asset_kind'] as String?),
          workOrderId: row['work_order_id'] as String?,
          photoUrl: row['photo_path'] as String?,
          mrid: row['mrid'] as String?,
          offlineSessionStartedAt:
              row['offline_session_started_at'] as String? ??
              DateTime.now().toUtc().toIso8601String(),
          operatorId: api.operatorId,
        );
        if (result.conflict) {
          await OfflineDb.markCaptureConflicted(row['id'] as int);
          continue;
        }
        await OfflineDb.markCaptureSynced(
          row['id'] as int,
          result.mrid ?? 'unknown',
        );
        synced++;
      } catch (_) {
        break;
      }
    }

    final pendingSpans = await OfflineDb.pendingSpans();
    for (final row in pendingSpans) {
      try {
        await api.submitFieldSpan(
          sourceNodeId: row['source_node_id'] as String,
          targetNodeId: row['target_node_id'] as String,
          boundaryFeederId: row['boundary_feeder_id'] as String?,
          workOrderId: row['work_order_id'] as String?,
          name: row['name'] as String?,
        );
        await OfflineDb.markSpanSynced(row['id'] as int);
        synced++;
      } catch (_) {
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
        await api.submitSpotBill(
          accountMrid: row['account_mrid'] as String,
          meterMrid: row['meter_mrid'] as String?,
          previousReadingKwh: previous,
          currentReadingKwh: current,
          evidencePhotoUrl: row['photo_path'] as String?,
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

  Future<int> syncAllPending() async {
    final captures = await syncPending();
    final bills = await syncPendingSpotBills();
    return captures + bills;
  }
}
