import 'package:latlong2/latlong.dart';

import '../utils/geo_json.dart';

/// A single assigned H3 hexagon (field-work territory) with its boundary ring.
class HexAssignment {
  const HexAssignment({
    required this.h3,
    required this.status,
    required this.ring,
    this.assignedTo,
    this.note,
  });

  final String h3;
  final String status;
  final List<LatLng> ring;
  final String? assignedTo;
  final String? note;

  bool get isDone => status == 'DONE';
  bool get isBlocked => status == 'BLOCKED';
  bool get isInProgress => status == 'IN_PROGRESS';

  static List<HexAssignment> listFromGeoJson(Map<String, dynamic> json) {
    final features = json['features'];
    if (features is! List) return const [];

    final out = <HexAssignment>[];
    for (final feature in features) {
      if (feature is! Map) continue;
      final props = feature['properties'];
      final propsMap = props is Map ? Map<String, dynamic>.from(props) : const {};
      final rings = polygonRingsFromGeoJson(feature['geometry']);
      if (rings.isEmpty) continue;
      out.add(
        HexAssignment(
          h3: propsMap['h3'] as String? ?? '',
          status: propsMap['status'] as String? ?? 'ASSIGNED',
          ring: rings.first,
          assignedTo: propsMap['assigned_to'] as String?,
          note: propsMap['note'] as String?,
        ),
      );
    }
    return out;
  }
}
