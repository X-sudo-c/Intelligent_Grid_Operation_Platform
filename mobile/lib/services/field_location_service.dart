import 'package:geolocator/geolocator.dart';

import 'giop_api.dart';

/// Throttled GPS uplink for backoffice field-crew map (auth-ready via operator id).
class FieldLocationService {
  FieldLocationService(this.api);

  final GiopApi api;
  DateTime? _lastSentAt;
  static const _minInterval = Duration(seconds: 30);

  Future<void> maybeReport(Position position) async {
    final now = DateTime.now();
    if (_lastSentAt != null && now.difference(_lastSentAt!) < _minInterval) {
      return;
    }
    _lastSentAt = now;
    try {
      await api.submitFieldLocation(
        longitude: position.longitude,
        latitude: position.latitude,
        accuracyM: position.accuracy,
        headingDeg: position.heading,
        speedMps: position.speed,
      );
    } catch (_) {
      // best-effort; next ping will retry
    }
  }
}
