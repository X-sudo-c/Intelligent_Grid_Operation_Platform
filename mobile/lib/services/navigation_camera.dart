import 'dart:math' as math;

/// Smooth map bearing for heading-up navigation (Google Maps style).
///
/// Sensor heading is written via [setBearingTarget]; [tick] returns the
/// display rotation to apply. Smoothing uses frame-delta exponential decay so
/// motion stays fluid without reading [MapController.camera.rotation] back
/// (which caused feedback jitter).
class NavigationCamera {
  double? _bearingTargetDeg;
  double? _displayRotationDeg;
  DateTime? _lastTickAt;

  double? get bearingTargetDeg => _bearingTargetDeg;

  double? get displayRotationDeg => _displayRotationDeg;

  void setBearingTarget(double? headingDeg) {
    if (headingDeg == null || !headingDeg.isFinite) return;
    _bearingTargetDeg = _normalizeHeading(headingDeg);
  }

  /// Advance smoothing; returns absolute map rotation (degrees, 0 = north).
  double? tick({double? dtSeconds}) {
    final heading = _bearingTargetDeg;
    if (heading == null) return null;

    final targetRotation = _normalizeRotation(-heading);
    final now = DateTime.now();
    final dt = dtSeconds ??
        (_lastTickAt == null
            ? 1 / 60
            : now.difference(_lastTickAt!).inMicroseconds / 1e6);
    _lastTickAt = now;
    final clampedDt = dt.clamp(0.001, 0.05);

    _displayRotationDeg ??= targetRotation;
    if (!_displayRotationDeg!.isFinite) {
      _displayRotationDeg = targetRotation;
      return _displayRotationDeg;
    }

    final delta = _shortestDelta(_displayRotationDeg!, targetRotation);
    final absDelta = delta.abs();

    // Adaptive time constant: snappy on large turns, damped on noise.
    final tau = absDelta > 35
        ? 0.055
        : absDelta > 12
            ? 0.10
            : absDelta > 3
                ? 0.16
                : 0.22;
    final alpha = 1 - math.exp(-clampedDt / tau);
    _displayRotationDeg =
        _normalizeRotation(_displayRotationDeg! + delta * alpha);

    return _displayRotationDeg;
  }

  void snapToTarget() {
    final heading = _bearingTargetDeg;
    if (heading == null) return;
    _displayRotationDeg = _normalizeRotation(-heading);
    _lastTickAt = DateTime.now();
  }

  void reset() {
    _bearingTargetDeg = null;
    _displayRotationDeg = null;
    _lastTickAt = null;
  }

  static double _normalizeHeading(double heading) =>
      (heading % 360 + 360) % 360;

  static double _normalizeRotation(double degrees) {
    var d = degrees % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  static double _shortestDelta(double from, double to) {
    var delta = to - from;
    while (delta > 180) {
      delta -= 360;
    }
    while (delta < -180) {
      delta += 360;
    }
    return delta;
  }
}
