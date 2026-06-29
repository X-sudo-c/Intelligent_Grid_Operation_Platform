import 'dart:async';

/// Requests a partial map refresh scoped to H3 cell(s), not a full map reload.
class FieldMapDeltaRequest {
  const FieldMapDeltaRequest({
    this.latitude,
    this.longitude,
    this.h3Index,
    this.ringK = 1,
    this.refreshAssignments = false,
  });

  final double? latitude;
  final double? longitude;
  final String? h3Index;
  final int ringK;
  final bool refreshAssignments;

  bool get hasLocation =>
      latitude != null &&
      longitude != null &&
      latitude!.isFinite &&
      longitude!.isFinite;

  bool get hasTarget => hasLocation || (h3Index != null && h3Index!.isNotEmpty);
}

/// Broadcast bus so notifications / shell can trigger map delta refresh.
class FieldMapRefreshBus {
  FieldMapRefreshBus._();

  static final FieldMapRefreshBus instance = FieldMapRefreshBus._();

  final _controller = StreamController<FieldMapDeltaRequest>.broadcast();

  Stream<FieldMapDeltaRequest> get stream => _controller.stream;

  void request(FieldMapDeltaRequest request) {
    if (!request.hasTarget) return;
    _controller.add(request);
  }

  void requestAt(double latitude, double longitude, {int ringK = 1, bool refreshAssignments = false}) {
    request(
      FieldMapDeltaRequest(
        latitude: latitude,
        longitude: longitude,
        ringK: ringK,
        refreshAssignments: refreshAssignments,
      ),
    );
  }

  void dispose() {
    _controller.close();
  }
}
