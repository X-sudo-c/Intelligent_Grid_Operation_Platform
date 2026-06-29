import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';

import '../models/asset_kind.dart';
import '../utils/geo.dart';
import '../utils/geo_json.dart';

class HighlightLine {
  const HighlightLine({
    required this.points,
    required this.voltage,
    this.lineMrid,
    this.fallback = false,
  });

  final List<LatLng> points;
  final String? voltage;
  final String? lineMrid;
  final bool fallback;
}

List<HighlightLine> highlightLinesFromTopology(
  Map<String, dynamic>? topology, {
  LatLng? origin,
  Map<String, LatLng> neighborPositionsByMrid = const {},
}) {
  if (topology == null) return const [];

  final lines = <HighlightLine>[];
  final seen = <String>{};

  void addFromList(List<dynamic> rows) {
    for (final row in rows) {
      if (row is! Map<String, dynamic>) continue;
      final lineMrid = row['line_mrid'] as String?;
      if (lineMrid != null && seen.contains(lineMrid)) continue;
      if (lineMrid != null) seen.add(lineMrid);

      var points = latLngsFromGeoJson(row['geom']);
      var fallback = false;

      if (points.length < 2) {
        final neighborLat = (row['neighbor_lat'] as num?)?.toDouble();
        final neighborLon = (row['neighbor_lon'] as num?)?.toDouble();
        if (neighborLat != null &&
            neighborLon != null &&
            isFiniteLatLng(neighborLat, neighborLon) &&
            origin != null) {
          points = [origin, LatLng(neighborLat, neighborLon)];
          fallback = true;
        } else {
          final neighborMrid = row['neighbor_mrid'] as String?;
          final neighbor = neighborMrid != null
              ? neighborPositionsByMrid[neighborMrid]
              : null;
          if (origin != null && neighbor != null) {
            points = [origin, neighbor];
            fallback = true;
          }
        }
      }

      if (points.length < 2) continue;

      lines.add(
        HighlightLine(
          points: points,
          voltage: row['voltage'] as String?,
          lineMrid: lineMrid,
          fallback: fallback,
        ),
      );
    }
  }

  addFromList(topology['downstream'] as List<dynamic>? ?? []);
  addFromList(topology['upstream'] as List<dynamic>? ?? []);
  return lines;
}

double highlightLineWidth(String? voltage, {bool fallback = false}) {
  final base = voltageLineWidth(voltage) + (fallback ? 0.0 : 1.5);
  return fallback ? base + 1.0 : base + 3.0;
}
