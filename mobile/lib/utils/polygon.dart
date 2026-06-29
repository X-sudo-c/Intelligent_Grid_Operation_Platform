import 'package:latlong2/latlong.dart';

/// Ray-casting point-in-polygon for assigned hex rings.
bool pointInPolygon(LatLng point, List<LatLng> ring) {
  if (ring.length < 3) return false;
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    final xi = ring[i].longitude;
    final yi = ring[i].latitude;
    final xj = ring[j].longitude;
    final yj = ring[j].latitude;
    final intersect = ((yi > point.latitude) != (yj > point.latitude)) &&
        (point.longitude <
            (xj - xi) * (point.latitude - yi) / (yj - yi + 0.0) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

bool pointInAnyAssignment(
  LatLng point,
  Iterable<List<LatLng>> rings,
) {
  for (final ring in rings) {
    if (pointInPolygon(point, ring)) return true;
  }
  return false;
}

LatLng boundsCenter(List<LatLng> points) {
  if (points.isEmpty) return const LatLng(0, 0);
  var lat = 0.0;
  var lon = 0.0;
  for (final p in points) {
    lat += p.latitude;
    lon += p.longitude;
  }
  return LatLng(lat / points.length, lon / points.length);
}
