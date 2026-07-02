import 'dart:convert';

import 'asset_kind.dart';

enum MapNodeLayer {
  onGrid,
  ownStaging,
  otherStaging,
  queuedLocal,
}

class AssetNode {
  AssetNode({
    required this.mrid,
    required this.name,
    required this.validation,
    this.latitude,
    this.longitude,
    this.boundaryFeederId,
    this.operatingUtility,
    this.substationName,
    this.tier = 'master',
    this.layer = MapNodeLayer.onGrid,
    this.assetKind = AssetKind.connectivityNode,
    this.wireDegree = 0,
    this.h3,
  });

  final String mrid;
  final String name;
  final String validation;
  final double? latitude;
  final double? longitude;
  final String? boundaryFeederId;
  final String? operatingUtility;
  final String? substationName;
  final String tier;
  final MapNodeLayer layer;
  final AssetKind assetKind;
  final int wireDegree;

  /// H3 cell index (set when streamed via /nodes/by-cells); null otherwise.
  final String? h3;

  bool get hasWireConnections => wireDegree > 0;

  /// Icon/color for map display (workflow layer for staging, asset kind for master).
  AssetKind get displayKind {
    if (layer == MapNodeLayer.onGrid) return assetKind;
    if (assetKind != AssetKind.connectivityNode) return assetKind;
    return AssetKind.fieldCapture;
  }

  bool get hasCoordinates =>
      latitude != null &&
      longitude != null &&
      latitude!.isFinite &&
      longitude!.isFinite;

  /// Device-only capture not yet on staging (mrid like `local:42`).
  bool get isLocalQueued =>
      layer == MapNodeLayer.queuedLocal ||
      mrid.startsWith('local:') ||
      mrid.startsWith('local-');

  AssetNode copyWith({MapNodeLayer? layer, AssetKind? assetKind, int? wireDegree}) {
    return AssetNode(
      mrid: mrid,
      name: name,
      validation: validation,
      latitude: latitude,
      longitude: longitude,
      boundaryFeederId: boundaryFeederId,
      operatingUtility: operatingUtility,
      substationName: substationName,
      tier: tier,
      layer: layer ?? this.layer,
      assetKind: assetKind ?? this.assetKind,
      wireDegree: wireDegree ?? this.wireDegree,
      h3: h3,
    );
  }

  static (double?, double?) coordinatesFromGeom(dynamic geom) {
    dynamic parsed = geom;
    if (parsed is String) {
      try {
        parsed = jsonDecode(parsed);
      } catch (_) {
        return (null, null);
      }
    }
    if (parsed is Map) {
      final coords = parsed['coordinates'];
      if (coords is List && coords.length >= 2) {
        return (
          (coords[1] as num).toDouble(),
          (coords[0] as num).toDouble(),
        );
      }
    }
    return (null, null);
  }

  static Map<String, dynamic>? _identifiedObjects(dynamic raw) {
    if (raw is Map<String, dynamic>) return raw;
    if (raw is Map) return Map<String, dynamic>.from(raw);
    if (raw is List && raw.isNotEmpty) {
      final first = raw.first;
      if (first is Map<String, dynamic>) return first;
      if (first is Map) return Map<String, dynamic>.from(first);
    }
    return null;
  }

  factory AssetNode.fromJson(Map<String, dynamic> json) {
    final identified = _identifiedObjects(json['identified_objects']);
    final ghanaRaw = identified?['ghana_grid_assets'];
    final Map<String, dynamic>? ghana = ghanaRaw is Map<String, dynamic>
        ? ghanaRaw
        : ghanaRaw is List && ghanaRaw.isNotEmpty
            ? ghanaRaw.first as Map<String, dynamic>
            : null;
    final (lat, lon) = coordinatesFromGeom(json['geom']);
    return AssetNode(
      mrid: json['mrid'] as String,
      name: identified?['name'] as String? ?? '—',
      validation: identified?['validation'] as String? ?? '—',
      latitude: lat,
      longitude: lon,
      boundaryFeederId: json['boundary_feeder_id'] as String?,
      operatingUtility: ghana?['operating_utility'] as String?,
      substationName: ghana?['substation_name'] as String?,
      tier: 'master',
      layer: MapNodeLayer.onGrid,
      assetKind: assetKindFromString(json['asset_kind'] as String?),
      wireDegree: (json['wire_degree'] as num?)?.toInt() ?? 0,
      h3: json['h3'] as String?,
    );
  }

  factory AssetNode.fromStagingJson(
    Map<String, dynamic> json, {
    required bool isOwnCapture,
    String? h3,
  }) {
    final (lat, lon) = coordinatesFromGeom(json['geom']);
    return AssetNode(
      mrid: json['mrid'] as String,
      name: json['name'] as String? ?? '—',
      validation: json['validation'] as String? ?? 'PENDING_FIELD',
      latitude: lat,
      longitude: lon,
      boundaryFeederId: json['boundary_feeder_id'] as String?,
      operatingUtility: json['operating_utility'] as String?,
      substationName: json['substation_name'] as String?,
      tier: 'staging',
      layer: isOwnCapture ? MapNodeLayer.ownStaging : MapNodeLayer.otherStaging,
      assetKind: assetKindFromString(json['asset_kind'] as String?),
      h3: h3 ?? json['h3'] as String?,
    );
  }

  factory AssetNode.fromCacheRow(Map<String, dynamic> row) {
    final layerRaw = row['layer'] as String?;
    MapNodeLayer layer = MapNodeLayer.onGrid;
    if (layerRaw != null) {
      try {
        layer = MapNodeLayer.values.byName(layerRaw);
      } catch (_) {
        layer = MapNodeLayer.onGrid;
      }
    }
    return AssetNode(
      mrid: row['mrid'] as String,
      name: row['name'] as String,
      validation: row['validation'] as String? ?? '—',
      latitude: (row['latitude'] as num).toDouble(),
      longitude: (row['longitude'] as num).toDouble(),
      boundaryFeederId: row['boundary_feeder_id'] as String?,
      operatingUtility: row['operating_utility'] as String?,
      substationName: row['substation_name'] as String?,
      tier: row['tier'] as String? ?? 'master',
      layer: layer,
      assetKind: assetKindFromString(row['asset_kind'] as String?),
      wireDegree: (row['wire_degree'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toCacheRow() {
    return {
      'mrid': mrid,
      'name': name,
      'validation': validation,
      'latitude': latitude,
      'longitude': longitude,
      'boundary_feeder_id': boundaryFeederId,
      'operating_utility': operatingUtility,
      'substation_name': substationName,
      'tier': tier,
      'layer': layer.name,
      'asset_kind': assetKindToApiValue(assetKind),
      'wire_degree': wireDegree,
    };
  }
}
