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
    String? substationName,
    String? boundaryFeederId,
  }) async {
    try {
      final result = await api.submitFieldNode(
        name: name,
        longitude: longitude,
        latitude: latitude,
        operatingUtility: operatingUtility,
        substationName: substationName,
        boundaryFeederId: boundaryFeederId,
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
    } catch (_) {
      await OfflineDb.queueFieldCapture(
        name: name,
        longitude: longitude,
        latitude: latitude,
      );
      return const CaptureResult(synced: false, queued: true);
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
