import 'dart:async';
import 'dart:math' as math;

import 'package:sensors_plus/sensors_plus.dart';

/// Fuses compass, gyro integration, and GPS course into a stable heading.
class HeadingFusionService {
  double? _heading;
  double _confidence = 0;
  bool _navigationMode = false;
  DateTime? _lastCompassAt;
  DateTime? _lastGyroAt;

  StreamSubscription<GyroscopeEvent>? _gyroSub;
  StreamSubscription<AccelerometerEvent>? _accelSub;

  double _accelX = 0;
  double _accelY = 0;
  double _accelZ = 9.8;

  static const _minWedgeConfidence = 0.45;

  double? get heading => _heading;

  double get confidence => _confidence.clamp(0, 1);

  bool get showHeadingWedge =>
      _heading != null && confidence >= _minWedgeConfidence;

  bool get navigationMode => _navigationMode;

  void setNavigationMode(bool enabled) {
    _navigationMode = enabled;
    if (enabled) {
      _confidence = math.max(_confidence, 0.55);
    }
  }

  /// Raw compass/azimuth for navigation camera (minimal filtering).
  void updateNavigationBearing(double? compassHeading) {
    if (compassHeading == null || !compassHeading.isFinite) return;
    final normalized = _normalize(compassHeading);
    // Light blend — heavy smoothing happens in NavigationCamera.
    final alpha = _heading == null ? 1.0 : 0.22;
    _heading = _blendAngle(_heading, normalized, alpha);
    _lastCompassAt = DateTime.now();
    _confidence = math.max(_confidence, 0.72);
    _decayConfidenceIfStale();
  }

  void start() {
    _gyroSub ??= gyroscopeEventStream().listen(_onGyro);
    _accelSub ??= accelerometerEventStream().listen((event) {
      _accelX = event.x;
      _accelY = event.y;
      _accelZ = event.z;
    });
  }

  void dispose() {
    _gyroSub?.cancel();
    _accelSub?.cancel();
    _gyroSub = null;
    _accelSub = null;
  }

  void updateCompass(double? compassHeading) {
    if (compassHeading == null || !compassHeading.isFinite) return;
    final normalized = _normalize(compassHeading);
    final alpha = _navigationMode ? 0.68 : 0.38;
    _heading = _blendAngle(_heading, normalized, alpha);
    _lastCompassAt = DateTime.now();
    _confidence = math.max(_confidence, 0.7);
    _decayConfidenceIfStale();
  }

  void updateGpsCourse({
    required double courseDeg,
    required double speedMps,
    required double accuracyMeters,
  }) {
    if (!courseDeg.isFinite || courseDeg < 0) return;
    // Stationary / slow: compass owns bearing in navigation mode.
    if (_navigationMode && speedMps < 2.5) return;
    if (speedMps < 0.8) return;
    final normalized = _normalize(courseDeg);
    final speedWeight = (speedMps / 4.0).clamp(0.35, 0.9);
    _heading = _blendAngle(_heading, normalized, speedWeight);
    _confidence = math.max(
      _confidence,
      (0.45 + speedMps / 5.0).clamp(0.45, 0.95),
    );
    if (accuracyMeters.isFinite && accuracyMeters < 12) {
      _confidence = math.min(1, _confidence + 0.08);
    }
    _decayConfidenceIfStale();
  }

  void penalizeForPoorAccuracy(double accuracyMeters) {
    if (!accuracyMeters.isFinite) return;
    if (accuracyMeters > 25) {
      _confidence = (_confidence * 0.85).clamp(0, 1);
    }
  }

  void _onGyro(GyroscopeEvent event) {
    // Navigation uses Android Rotation Vector via compass; extra gyro fights it.
    if (_navigationMode || _heading == null) return;
    final now = DateTime.now();
    final last = _lastGyroAt;
    _lastGyroAt = now;
    if (last == null) return;

    final dt = now.difference(last).inMicroseconds / 1e6;
    if (dt <= 0 || dt > 0.25) return;
    if (!_isMapViewOrientation()) return;

    // Portrait map viewing: device yaw rate is mostly around the Z axis.
    final yawRateDegPerSec = event.z * 180 / math.pi;
    _heading = _normalize(_heading! - yawRateDegPerSec * dt);

    final compassAge = _lastCompassAt == null
        ? const Duration(days: 1)
        : now.difference(_lastCompassAt!);
    if (compassAge.inMilliseconds > 350) {
      _confidence = (_confidence * 0.985).clamp(0, 1);
    }
  }

  bool _isMapViewOrientation() {
    final magnitude = math.sqrt(
      _accelX * _accelX + _accelY * _accelY + _accelZ * _accelZ,
    );
    if (magnitude < 4) return false;
    // Accept typical handheld portrait/tilted map viewing.
    return _accelZ.abs() / magnitude > 0.35;
  }

  void _decayConfidenceIfStale() {
    final last = _lastCompassAt;
    if (last == null) return;
    final ageSec = DateTime.now().difference(last).inSeconds;
    if (ageSec > 4) {
      _confidence = (_confidence * 0.7).clamp(0, 1);
    }
  }

  double _normalize(double heading) => (heading % 360 + 360) % 360;

  double _blendAngle(double? current, double next, double alpha) {
    if (current == null) return next;
    var diff = next - current;
    while (diff > 180) {
      diff -= 360;
    }
    while (diff < -180) {
      diff += 360;
    }
    return _normalize(current + diff * alpha);
  }
}
