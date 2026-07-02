import 'dart:async';

/// Imperative fly-to requests (work orders, search results).
class FieldMapFlyRequest {
  const FieldMapFlyRequest({
    required this.token,
    required this.latitude,
    required this.longitude,
    this.label,
    this.zoom = 17.0,
  });

  final int token;
  final double latitude;
  final double longitude;
  final String? label;
  final double zoom;
}

class FieldMapFlyBus {
  FieldMapFlyBus._();

  static final FieldMapFlyBus instance = FieldMapFlyBus._();

  final _controller = StreamController<FieldMapFlyRequest>.broadcast();
  int _token = 0;

  Stream<FieldMapFlyRequest> get stream => _controller.stream;

  void flyTo({
    required double latitude,
    required double longitude,
    String? label,
    double zoom = 17.0,
  }) {
    if (!latitude.isFinite || !longitude.isFinite) return;
    _token += 1;
    _controller.add(
      FieldMapFlyRequest(
        token: _token,
        latitude: latitude,
        longitude: longitude,
        label: label,
        zoom: zoom,
      ),
    );
  }
}
