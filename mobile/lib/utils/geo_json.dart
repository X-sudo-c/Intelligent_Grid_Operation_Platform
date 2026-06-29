import 'dart:convert';

import 'package:latlong2/latlong.dart';

import '../utils/geo.dart';

/// Parse GeoJSON geometry from RPC/REST (object or JSON string).
dynamic normalizeGeoJson(dynamic geom) {
  if (geom is Map<String, dynamic>) return geom;
  if (geom is String && geom.trim().isNotEmpty) {
    try {
      final decoded = jsonDecode(geom);
      if (decoded is Map<String, dynamic>) return decoded;
    } catch (_) {
      return null;
    }
  }
  return null;
}

List<LatLng> latLngsFromGeoJson(dynamic geom) {
  final map = normalizeGeoJson(geom);
  if (map is! Map<String, dynamic>) return const [];

  final type = map['type'] as String?;
  final coords = map['coordinates'];
  if (coords is! List) return const [];

  if (type == 'LineString') {
    return _parseLineCoords(coords);
  }
  if (type == 'MultiLineString') {
    var best = <LatLng>[];
    for (final part in coords) {
      if (part is! List) continue;
      final line = _parseLineCoords(part);
      if (line.length > best.length) best = line;
    }
    return best;
  }
  return const [];
}

List<LatLng> _parseLineCoords(List<dynamic> coords) {
  final points = <LatLng>[];
  for (final c in coords) {
    if (c is! List || c.length < 2) continue;
    final lat = (c[1] as num).toDouble();
    final lon = (c[0] as num).toDouble();
    if (isFiniteLatLng(lat, lon)) {
      points.add(LatLng(lat, lon));
    }
  }
  return points;
}

/// Outer rings from a GeoJSON Polygon / MultiPolygon (each ring is a point list).
List<List<LatLng>> polygonRingsFromGeoJson(dynamic geom) {
  final map = normalizeGeoJson(geom);
  if (map is! Map<String, dynamic>) return const [];

  final type = map['type'] as String?;
  final coords = map['coordinates'];
  if (coords is! List) return const [];

  if (type == 'Polygon') {
    if (coords.isEmpty || coords.first is! List) return const [];
    final ring = _parseLineCoords(coords.first as List);
    return ring.length >= 3 ? [ring] : const [];
  }
  if (type == 'MultiPolygon') {
    final rings = <List<LatLng>>[];
    for (final poly in coords) {
      if (poly is! List || poly.isEmpty || poly.first is! List) continue;
      final ring = _parseLineCoords(poly.first as List);
      if (ring.length >= 3) rings.add(ring);
    }
    return rings;
  }
  return const [];
}
