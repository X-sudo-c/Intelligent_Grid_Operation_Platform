import 'package:geolocator/geolocator.dart';

import '../debug_agent_log.dart';
import 'connectivity_service.dart';
import 'giop_api.dart';

/// Throttled GPS uplink for backoffice field-crew map (auth-ready via operator id).
class FieldLocationService {
  FieldLocationService(this.api);

  final GiopApi api;
  DateTime? _lastSuccessAt;
  DateTime? _lastAttemptAt;
  static const _successInterval = Duration(seconds: 30);
  static const _failureRetryInterval = Duration(seconds: 15);

  /// Immediate uplink — used on first GPS fix so backoffice sees the user quickly.
  Future<void> reportNow(Position position) => _send(position, force: true);

  Future<void> maybeReport(Position position) async {
    final now = DateTime.now();
    if (_lastSuccessAt != null &&
        now.difference(_lastSuccessAt!) < _successInterval) {
      return;
    }
    if (_lastSuccessAt == null &&
        _lastAttemptAt != null &&
        now.difference(_lastAttemptAt!) < _failureRetryInterval) {
      return;
    }
    await _send(position);
  }

  Future<void> _send(Position position, {bool force = false}) async {
    if (!force && !ConnectivityService.instance.lastLinkUp) {
      return;
    }
    if (!force) {
      final reachable = await ConnectivityService.instance.probeSyncNow();
      if (!reachable) {
        agentLog(
          location: 'field_location_service.dart:_send',
          message: 'field location skipped — sync unreachable',
          hypothesisId: 'H-field',
          runId: 'field-1',
          ingestHost: hostFromUrl(api.config.syncBaseUrl),
          data: {
            'technicianId': api.config.technicianId,
            'syncUrl': api.config.syncBaseUrl,
          },
        );
        return;
      }
    }

    _lastAttemptAt = DateTime.now();
    try {
      await api.submitFieldLocation(
        longitude: position.longitude,
        latitude: position.latitude,
        accuracyM: position.accuracy,
        headingDeg: position.heading,
        speedMps: position.speed,
      );
      _lastSuccessAt = DateTime.now();
      agentLog(
        location: 'field_location_service.dart:_send',
        message: 'field location reported',
        hypothesisId: 'H-field',
        runId: 'field-1',
        ingestHost: hostFromUrl(api.config.syncBaseUrl),
        data: {
          'technicianId': api.config.technicianId,
          'lat': position.latitude,
          'lon': position.longitude,
        },
      );
    } catch (e) {
      ConnectivityService.instance.probeSyncNow();
      agentLog(
        location: 'field_location_service.dart:_send',
        message: 'field location failed',
        hypothesisId: 'H-field',
        runId: 'field-1',
        ingestHost: hostFromUrl(api.config.syncBaseUrl),
        data: {
          'technicianId': api.config.technicianId,
          'error': e.toString(),
          'syncUrl': api.config.syncBaseUrl,
        },
      );
    }
  }
}
