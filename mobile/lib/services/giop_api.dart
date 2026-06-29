import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:latlong2/latlong.dart';

import '../map/giop_martin_theme.dart';
import '../config/api_config.dart';
import '../models/asset_node.dart';
import '../models/asset_kind.dart';
import '../models/hex_assignment.dart';
import 'offline_db.dart';

class FieldSubmitResult {
  const FieldSubmitResult({
    required this.success,
    this.mrid,
    this.conflict = false,
    this.conflictId,
    this.message,
  });

  final bool success;
  final String? mrid;
  final bool conflict;
  final String? conflictId;
  final String? message;
}

class FieldNotification {
  const FieldNotification({
    required this.id,
    required this.messageType,
    this.title,
    this.body,
    this.mrid,
    this.name,
    this.reason,
    this.createdAt,
    this.latitude,
    this.longitude,
  });

  final String id;
  final String messageType;
  final String? title;
  final String? body;
  final String? mrid;
  final String? name;
  final String? reason;
  final String? createdAt;
  final double? latitude;
  final double? longitude;

  factory FieldNotification.fromJson(Map<String, dynamic> json) {
    final payload = json['payload'];
    final map = payload is Map
        ? Map<String, dynamic>.from(payload)
        : <String, dynamic>{};
    return FieldNotification(
      id: json['id'] as String? ?? '',
      messageType: json['message_type'] as String? ?? '',
      title: map['title'] as String?,
      body: map['body'] as String?,
      mrid: map['mrid'] as String?,
      name: map['name'] as String?,
      reason: map['reason'] as String?,
      createdAt: json['created_at'] as String?,
      latitude: (map['latitude'] as num?)?.toDouble(),
      longitude: (map['longitude'] as num?)?.toDouble(),
    );
  }

  Map<String, dynamic> toPayload() => {
        'id': id,
        'message_type': messageType,
        'title': title,
        'body': body,
        'mrid': mrid,
        'name': name,
        'reason': reason,
        'created_at': createdAt,
        'latitude': latitude,
        'longitude': longitude,
      };
}

class TechnicianSubmission {
  const TechnicianSubmission({
    required this.mrid,
    required this.name,
    required this.validation,
    this.errorLog,
    this.updatedAt,
    this.latitude,
    this.longitude,
  });

  final String mrid;
  final String name;
  final String validation;
  final String? errorLog;
  final String? updatedAt;
  final double? latitude;
  final double? longitude;

  factory TechnicianSubmission.fromJson(Map<String, dynamic> json) {
    double? lat;
    double? lon;
    final geom = json['geom'];
    if (geom is Map) {
      final coords = geom['coordinates'];
      if (coords is List && coords.length >= 2) {
        lon = (coords[0] as num).toDouble();
        lat = (coords[1] as num).toDouble();
      }
    }
    return TechnicianSubmission(
      mrid: json['mrid'] as String? ?? '',
      name: json['name'] as String? ?? '',
      validation: json['validation'] as String? ?? '',
      errorLog: json['error_log'] as String?,
      updatedAt: json['updated_at'] as String?,
      latitude: lat,
      longitude: lon,
    );
  }
}

class NearbyAssetHit {
  const NearbyAssetHit({
    required this.mrid,
    required this.name,
    required this.tier,
    required this.distanceM,
    this.assetKind,
  });

  final String mrid;
  final String name;
  final String tier;
  final double distanceM;
  final String? assetKind;

  factory NearbyAssetHit.fromJson(Map<String, dynamic> json) {
    return NearbyAssetHit(
      mrid: json['mrid'] as String? ?? '',
      name: json['name'] as String? ?? '',
      tier: json['tier'] as String? ?? '',
      distanceM: (json['distance_m'] as num?)?.toDouble() ?? 0,
      assetKind: json['asset_kind'] as String?,
    );
  }
}

class SnapPointResult {
  const SnapPointResult({
    required this.snapped,
    required this.longitude,
    required this.latitude,
    this.snapType,
    this.snappedToName,
    this.snappedToMrid,
    this.distanceM,
  });

  final bool snapped;
  final double longitude;
  final double latitude;
  final String? snapType;
  final String? snappedToName;
  final String? snappedToMrid;
  final double? distanceM;

  factory SnapPointResult.fromJson(Map<String, dynamic> json) {
    return SnapPointResult(
      snapped: json['snapped'] as bool? ?? false,
      longitude: (json['longitude'] as num).toDouble(),
      latitude: (json['latitude'] as num).toDouble(),
      snapType: json['snap_type'] as String?,
      snappedToName: json['snapped_to_name'] as String?,
      snappedToMrid: json['snapped_to_mrid'] as String?,
      distanceM: (json['distance_m'] as num?)?.toDouble(),
    );
  }
}

class StagingSpan {
  const StagingSpan({
    required this.mrid,
    required this.sourceNodeId,
    required this.targetNodeId,
    required this.points,
    this.name,
  });

  final String mrid;
  final String sourceNodeId;
  final String targetNodeId;
  final List<LatLng> points;
  final String? name;

  factory StagingSpan.fromJson(Map<String, dynamic> json) {
    final points = <LatLng>[];
    final geom = json['geom'];
    if (geom is Map && geom['coordinates'] is List) {
      for (final c in geom['coordinates'] as List) {
        if (c is List && c.length >= 2) {
          points.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
        }
      }
    }
    return StagingSpan(
      mrid: json['mrid'] as String? ?? '',
      name: json['name'] as String?,
      sourceNodeId: json['source_node_id'] as String? ?? '',
      targetNodeId: json['target_node_id'] as String? ?? '',
      points: points,
    );
  }
}

class GiopApi {
  GiopApi(this.config)
      : _dio = Dio(
          BaseOptions(
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 60),
          ),
        );

  final ApiConfig config;
  final Dio _dio;

  String get _syncUrl => config.normalizedSyncBaseUrl;

  Map<String, String> get _supabaseHeaders => {
        'apikey': config.supabaseAnonKey,
        'Authorization': 'Bearer ${config.supabaseAnonKey}',
      };

  /// Master + staging nodes with coordinates for the map.
  /// When [latitude] and [longitude] are set, loads the nearest on-grid nodes first.
  /// Returns cached nodes when the network request fails.
  Future<({List<AssetNode> nodes, bool fromCache, String? issue})> fetchMapNodes({
    double? latitude,
    double? longitude,
    List<AssetNode>? preloadedMaster,
  }) async {
    final ownMrids = await OfflineDb.knownLocalMrids();
    List<AssetNode> master = preloadedMaster ?? const [];
    List<AssetNode> staging = const [];
    Object? masterError;
    Object? stagingError;
    var rawMasterCount = preloadedMaster?.length ?? 0;

    if (preloadedMaster == null) {
      final masterResult = await _fetchMasterAssets(
        latitude: latitude,
        longitude: longitude,
      );
      master = masterResult.nodes;
      masterError = masterResult.error;
      rawMasterCount = master.length;
    }

    try {
      staging = await _fetchStagingAssets(ownMrids);
    } catch (e) {
      stagingError = e;
    }

    final pending = await OfflineDb.pendingCaptures();
    final nodes = <AssetNode>[...master, ...staging];
    var usedCachedMaster = false;

    if (rawMasterCount == 0 && masterError != null) {
      try {
        final cached = await OfflineDb.loadCachedMapNodes();
        final cachedMaster =
            cached.where((n) => n.tier == 'master' && n.hasCoordinates);
        if (cachedMaster.isNotEmpty) {
          final seenMridsForCache = nodes.map((n) => n.mrid).toSet();
          for (final node in cachedMaster) {
            if (!seenMridsForCache.contains(node.mrid)) {
              nodes.add(node);
              usedCachedMaster = true;
            }
          }
        }
      } catch (_) {
        // ignore corrupt cache
      }
    }
    final seenMrids = nodes.map((n) => n.mrid).toSet();

    for (final row in pending) {
      final mrid = row['mrid'] as String?;
      if (mrid != null && seenMrids.contains(mrid)) continue;
      final localId = row['id'] as int;
      nodes.add(
        AssetNode(
          mrid: mrid ?? 'local-$localId',
          name: row['name'] as String,
          validation: 'PENDING_FIELD',
          latitude: (row['latitude'] as num).toDouble(),
          longitude: (row['longitude'] as num).toDouble(),
          tier: 'staging',
          layer: MapNodeLayer.queuedLocal,
          assetKind: assetKindFromString(row['asset_kind'] as String?),
        ),
      );
    }

    final withCoords = nodes.where((n) => n.hasCoordinates).toList();
    if (withCoords.isEmpty) {
      try {
        final cached = await OfflineDb.loadCachedMapNodes();
        if (cached.isNotEmpty) {
          prefetchConnectionsForNodes(
            cached.where((n) => n.tier == 'master').map((n) => n.mrid).toList(),
          );
          return (nodes: cached, fromCache: true, issue: null);
        }
      } catch (_) {
        // ignore corrupt cache
      }
      final issue = _describeLoadFailure(
        masterError: masterError,
        stagingError: stagingError,
        rawCount: nodes.length,
        rawMasterCount: rawMasterCount,
      );
      return (nodes: const <AssetNode>[], fromCache: false, issue: issue);
    }

    try {
      await OfflineDb.cacheMapNodes(withCoords);
    } catch (_) {
      // Cache write must not hide a successful network fetch.
    }

    final masterMrids = withCoords
        .where((n) => n.tier == 'master')
        .map((n) => n.mrid)
        .toList();
    prefetchConnectionsForNodes(
      masterMrids,
      nearLat: latitude,
      nearLon: longitude,
    );
    final String? issue = withCoords.isEmpty
        ? (rawMasterCount == 0 && masterError != null
            ? _masterLoadIssue(
                masterError: masterError,
                visibleCount: 0,
                fromCacheMaster: usedCachedMaster,
              )
            : rawMasterCount == 0
                ? 'No master grid nodes returned for this area.'
                : _describeLoadFailure(
                    masterError: masterError,
                    stagingError: stagingError,
                    rawCount: nodes.length,
                    rawMasterCount: rawMasterCount,
                  ))
        : null;
    return (nodes: withCoords, fromCache: usedCachedMaster && rawMasterCount == 0, issue: issue);
  }

  String _masterLoadIssue({
    required Object masterError,
    required int visibleCount,
    required bool fromCacheMaster,
  }) {
    final detail = _shortError(masterError);
    if (visibleCount == 0) {
      return 'Grid nodes failed to load: $detail';
    }
    if (fromCacheMaster) {
      return 'Live grid unavailable ($detail). Showing cached grid + local markers.';
    }
    return 'Grid nodes unavailable ($detail). Showing $visibleCount local/staging markers.';
  }

  String _describeLoadFailure({
    required Object? masterError,
    required Object? stagingError,
    required int rawCount,
    required int rawMasterCount,
  }) {
    if (config.usesEmulatorLoopback) {
      return 'Cannot load grid data. On a physical phone, open Settings and set '
          'your PC LAN IP (not 10.0.2.2). Example sync URL: http://192.168.1.10:5000';
    }
    if (masterError != null) {
      return 'Grid API failed: ${_shortError(masterError)}';
    }
    if (stagingError != null && rawMasterCount == 0) {
      return 'Sync service failed: ${_shortError(stagingError)}';
    }
    if (rawCount > 0) {
      return 'Server returned $rawCount assets but none had map coordinates.';
    }
    return 'No nodes near this location. Check sync-service URL in Settings.';
  }

  String _shortError(Object error) {
    if (error is DioException) {
      final uri = error.requestOptions.uri;
      switch (error.type) {
        case DioExceptionType.connectionTimeout:
        case DioExceptionType.receiveTimeout:
        case DioExceptionType.sendTimeout:
          return 'timeout reaching $uri';
        case DioExceptionType.connectionError:
          return 'cannot connect to $uri — is the service running on 0.0.0.0?';
        default:
          return error.message ?? error.toString();
      }
    }
    return error.toString();
  }

  List<dynamic> _parseRpcRows(dynamic raw) {
    if (raw is List) return raw;
    if (raw is String) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is List) return decoded;
      } catch (_) {
        return const [];
      }
    }
    return const [];
  }

  /// Quick reachability check for Settings screen.
  Future<String> testConnections() async {
    final lines = <String>[];
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '$_syncUrl/api/v1/map/nodes',
        queryParameters: {
          'lat': defaultMapLat,
          'lon': defaultMapLon,
          'limit': 3,
        },
        options: Options(
          receiveTimeout: const Duration(seconds: 15),
          connectTimeout: const Duration(seconds: 8),
        ),
      );
      final count = (response.data?['count'] as num?)?.toInt() ?? 0;
      lines.add('Map nodes (sync :5000): OK ($count sample nodes)');
    } catch (e) {
      lines.add('Map nodes (sync :5000): FAIL — ${_shortError(e)}');
      lines.add('On PC run: ./scripts/start-sync-service.sh');
    }

    try {
      final martinOk = await probeMartinReachable(config.martinBaseUrl);
      lines.add('Martin URL: ${config.martinBaseUrl}');
      lines.add(
        martinOk
            ? 'Martin tiles (:3001): OK — SLD vector grid enabled'
            : 'Martin tiles (:3001): FAIL — poles/lines need Martin. '
                'On PC: docker start giop-martin',
      );
    } catch (e) {
      lines.add('Martin tiles (:3001): FAIL — $e');
    }

    if (config.preferSyncOnly) {
      lines.add(
        'Supabase: skipped on phone (port 54321 often blocked). '
        'Map uses sync :5000 only.',
      );
    } else {
      try {
        final response = await _dio.post<dynamic>(
          '${config.supabaseUrl}/rest/v1/rpc/nodes_near_location',
          data: {'p_lat': defaultMapLat, 'p_lon': defaultMapLon, 'p_limit': 1},
          options: Options(
            headers: _supabaseHeaders,
            receiveTimeout: const Duration(seconds: 8),
            connectTimeout: const Duration(seconds: 5),
          ),
        );
        if (response.data is Map && (response.data as Map).containsKey('message')) {
          lines.add('Supabase: FAIL — ${(response.data as Map)['message']}');
        } else {
          final count = _parseRpcRows(response.data).length;
          lines.add('Supabase: OK ($count sample node${count == 1 ? '' : 's'})');
        }
      } catch (e) {
        lines.add('Supabase: FAIL — ${_shortError(e)}');
      }
    }

    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '$_syncUrl/api/v1/assets/staging',
        options: Options(receiveTimeout: const Duration(seconds: 8)),
      );
      final count = (response.data?['assets'] as List?)?.length ?? 0;
      lines.add('Sync service: OK ($count staging)');
    } catch (e) {
      lines.add('Sync service: FAIL — ${_shortError(e)}');
    }

    if (config.usesEmulatorLoopback) {
      lines.add(
        'Note: 10.0.2.2 only works on the Android emulator, not a physical phone.',
      );
    }
    return lines.join('\n');
  }

  Future<List<AssetNode>> fetchAssets() async {
    final result = await fetchMapNodes();
    return result.nodes;
  }

  static const defaultMapLat = 5.6037;
  static const defaultMapLon = -0.187;

  Future<List<AssetNode>> _fetchMasterFromSync({
    required double latitude,
    required double longitude,
    int limit = 200,
    bool preferWired = false,
  }) async {
    DioException? lastError;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        final syncResponse = await _dio.get<Map<String, dynamic>>(
          '$_syncUrl/api/v1/map/nodes',
          queryParameters: {
            'lat': latitude,
            'lon': longitude,
            'limit': limit,
            'prefer_wired': preferWired,
          },
          options: Options(
            receiveTimeout: Duration(seconds: preferWired ? 90 : 25),
            connectTimeout: const Duration(seconds: 10),
          ),
        );
        final nodes = syncResponse.data?['nodes'];
        if (nodes is List) {
          return _parseMasterNodeRows(nodes);
        }
        return const [];
      } on DioException catch (e) {
        lastError = e;
        if (attempt == 0 && _isRetryableConnection(e)) {
          await Future<void>.delayed(const Duration(milliseconds: 400));
          continue;
        }
        rethrow;
      }
    }
    throw lastError ?? Exception('Sync map API failed');
  }

  /// H3 streaming: fetch master + staging nodes for hex cells.
  Future<({
    List<AssetNode> nodes,
    List<String> cells,
    List<String> fetchedCells,
    Object? error,
  })> fetchMapNodesByCells({
    required double latitude,
    required double longitude,
    int k = 1,
    int res = 9,
    Iterable<String> have = const <String>[],
    bool includeStaging = true,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '$_syncUrl/api/v1/nodes/by-cells',
        queryParameters: {
          'lat': latitude,
          'lng': longitude,
          'k': k,
          'res': res,
          'include_staging': includeStaging,
          if (have.isNotEmpty) 'have': have.join(','),
        },
        options: Options(
          receiveTimeout: const Duration(seconds: 25),
          connectTimeout: const Duration(seconds: 10),
        ),
      );
      final data = response.data ?? const <String, dynamic>{};
      final rawNodes = data['nodes'];
      final ownMrids = await OfflineDb.knownLocalMrids();
      final nodes = rawNodes is List
          ? _parseCellNodeRows(rawNodes, ownMrids)
          : <AssetNode>[];
      final cells = (data['cells'] as List?)
              ?.map((e) => e.toString())
              .toList() ??
          <String>[];
      final fetchedCells = (data['fetched_cells'] as List?)
              ?.map((e) => e.toString())
              .toList() ??
          <String>[];
      return (
        nodes: nodes,
        cells: cells,
        fetchedCells: fetchedCells,
        error: null,
      );
    } catch (e) {
      return (
        nodes: const <AssetNode>[],
        cells: const <String>[],
        fetchedCells: const <String>[],
        error: e,
      );
    }
  }

  /// Force-refresh map nodes for specific H3 cells (delta update, no full map load).
  Future<({
    List<AssetNode> nodes,
    List<String> cells,
    Object? error,
  })> fetchMapNodesForCells({
    required List<String> cells,
    int res = 9,
    bool includeStaging = true,
  }) async {
    if (cells.isEmpty) {
      return (nodes: const <AssetNode>[], cells: const <String>[], error: null);
    }
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '$_syncUrl/api/v1/nodes/by-cells',
        queryParameters: {
          'cells': cells.join(','),
          'res': res,
          'include_staging': includeStaging,
        },
        options: Options(
          receiveTimeout: const Duration(seconds: 25),
          connectTimeout: const Duration(seconds: 10),
        ),
      );
      final data = response.data ?? const <String, dynamic>{};
      final rawNodes = data['nodes'];
      final ownMrids = await OfflineDb.knownLocalMrids();
      final nodes = rawNodes is List
          ? _parseCellNodeRows(rawNodes, ownMrids)
          : <AssetNode>[];
      final outCells = (data['cells'] as List?)
              ?.map((e) => e.toString())
              .toList() ??
          cells;
      return (nodes: nodes, cells: outCells, error: null);
    } catch (e) {
      return (
        nodes: const <AssetNode>[],
        cells: cells,
        error: e,
      );
    }
  }

  /// H3 cell delta: re-fetch a small ring around a point (ignores cached cells).
  Future<({
    List<AssetNode> nodes,
    List<String> cells,
    Object? error,
  })> fetchMapCellDelta({
    double? latitude,
    double? longitude,
    String? h3Index,
    int k = 1,
    int res = 9,
    bool includeStaging = true,
  }) async {
    if (h3Index != null && h3Index.isNotEmpty) {
      return fetchMapNodesForCells(
        cells: [h3Index],
        res: res,
        includeStaging: includeStaging,
      );
    }
    if (latitude == null || longitude == null) {
      return (
        nodes: const <AssetNode>[],
        cells: const <String>[],
        error: Exception('fetchMapCellDelta requires lat/lng or h3Index'),
      );
    }
    final ring = await fetchMapNodesByCells(
      latitude: latitude,
      longitude: longitude,
      k: k,
      res: res,
      have: const <String>[],
      includeStaging: includeStaging,
    );
    return (
      nodes: ring.nodes,
      cells: ring.cells,
      error: ring.error,
    );
  }

  /// Fetch the current technician's assigned H3 hexagons (work territory).
  /// Returns hex polygons so the map can draw the scope of assigned work.
  Future<List<HexAssignment>> fetchMyAssignments({
    String? assignedTo,
    List<String> statuses = const ['ASSIGNED', 'IN_PROGRESS'],
  }) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/h3/assignments/geojson',
      queryParameters: {
        'assigned_to': assignedTo ?? config.technicianId,
        if (statuses.isNotEmpty) 'status': statuses.join(','),
      },
      options: Options(
        receiveTimeout: const Duration(seconds: 20),
        connectTimeout: const Duration(seconds: 10),
      ),
    );
    final data = response.data ?? const <String, dynamic>{};
    return HexAssignment.listFromGeoJson(Map<String, dynamic>.from(data));
  }

  /// Fast map paint: quick master KNN first, then merge staging/offline layers.
  Future<
      ({
        List<AssetNode> nodes,
        bool fromCache,
        String? issue,
        int masterMs,
        int totalMs,
      })> fetchMapNodesFast({
    double? latitude,
    double? longitude,
  }) async {
    final total = Stopwatch()..start();
    final quick = await fetchMapNodesQuick(
      latitude: latitude,
      longitude: longitude,
    );
    final masterMs = total.elapsedMilliseconds;

    if (quick.nodes.isEmpty && quick.error != null) {
      final fallback = await fetchMapNodes(
        latitude: latitude,
        longitude: longitude,
      );
      return (
        nodes: fallback.nodes,
        fromCache: fallback.fromCache,
        issue: fallback.issue,
        masterMs: masterMs,
        totalMs: total.elapsedMilliseconds,
      );
    }

    final merged = await fetchMapNodes(
      latitude: latitude,
      longitude: longitude,
      preloadedMaster: quick.nodes,
    );
    return (
      nodes: merged.nodes,
      fromCache: merged.fromCache,
      issue: merged.issue,
      masterMs: masterMs,
      totalMs: total.elapsedMilliseconds,
    );
  }

  /// Quick nearest-neighbor fetch for map paint (sub-second on LAN).
  Future<({List<AssetNode> nodes, Object? error})> fetchMapNodesQuick({
    double? latitude,
    double? longitude,
  }) async {
    final lat = (latitude != null && latitude.isFinite) ? latitude : defaultMapLat;
    final lon = (longitude != null && longitude.isFinite) ? longitude : defaultMapLon;
    try {
      final nodes = await _fetchMasterFromSync(
        latitude: lat,
        longitude: lon,
        limit: 150,
        preferWired: false,
      );
      return (nodes: nodes, error: nodes.isEmpty ? Exception('Sync returned 0 nodes') : null);
    } on DioException catch (e) {
      return (
        nodes: const <AssetNode>[],
        error: Exception('Sync map API failed: ${_shortError(e)}'),
      );
    } catch (e) {
      return (nodes: const <AssetNode>[], error: e);
    }
  }

  bool _isRetryableConnection(DioException error) {
    switch (error.type) {
      case DioExceptionType.connectionError:
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
        return true;
      default:
        return false;
    }
  }

  Future<({List<AssetNode> nodes, Object? error})> _fetchMasterAssets({
    double? latitude,
    double? longitude,
  }) async {
    final lat = (latitude != null && latitude.isFinite) ? latitude : defaultMapLat;
    final lon = (longitude != null && longitude.isFinite) ? longitude : defaultMapLon;

    try {
      final fromSync = await _fetchMasterFromSync(
        latitude: lat,
        longitude: lon,
        limit: 200,
        preferWired: false,
      );
      if (fromSync.isNotEmpty) {
        return (nodes: fromSync, error: null);
      }
      if (config.preferSyncOnly) {
        return (
          nodes: const <AssetNode>[],
          error: Exception(
            'Sync returned 0 nodes. Is sync-service running? '
            'On PC: ./scripts/start-sync-service.sh',
          ),
        );
      }
    } on DioException catch (e) {
      if (config.preferSyncOnly) {
        return (
          nodes: const <AssetNode>[],
          error: Exception('Sync map API failed: ${_shortError(e)}'),
        );
      }
      // emulator / localhost: try Supabase below
    }

    if (config.preferSyncOnly) {
      return (
        nodes: const <AssetNode>[],
        error: Exception(
          'Map nodes unavailable from sync-service at $_syncUrl',
        ),
      );
    }

    try {
      final response = await _dio.post<dynamic>(
        '${config.supabaseUrl}/rest/v1/rpc/nodes_near_location',
        data: {
          'p_lat': lat,
          'p_lon': lon,
          'p_limit': 500,
          'p_prefer_wired': true,
        },
        options: Options(
          headers: _supabaseHeaders,
          receiveTimeout: const Duration(seconds: 30),
          connectTimeout: const Duration(seconds: 8),
        ),
      );
      if (response.statusCode != null && response.statusCode! >= 400) {
        return (
          nodes: const <AssetNode>[],
          error: DioException(
            requestOptions: response.requestOptions,
            response: response,
            type: DioExceptionType.badResponse,
            message: response.data?.toString(),
          ),
        );
      }
      final raw = response.data;
      if (raw is Map && raw.containsKey('message')) {
        return (
          nodes: const <AssetNode>[],
          error: Exception('nodes_near_location: ${raw['message']}'),
        );
      }
      return (nodes: _parseMasterNodeRows(_parseRpcRows(raw)), error: null);
    } catch (e) {
      return (nodes: const <AssetNode>[], error: e);
    }
  }

  List<AssetNode> _parseCellNodeRows(List<dynamic> rows, Set<String> ownMrids) {
    final nodes = <AssetNode>[];
    for (final row in rows) {
      try {
        if (row is! Map) continue;
        final map = row is Map<String, dynamic>
            ? row
            : Map<String, dynamic>.from(row);
        if (map['tier'] == 'staging') {
          nodes.add(
            AssetNode.fromStagingJson(
              map,
              isOwnCapture: ownMrids.contains(map['mrid'] as String?),
            ),
          );
        } else {
          nodes.add(AssetNode.fromJson(map));
        }
      } catch (_) {
        // skip malformed row
      }
    }
    return nodes;
  }

  List<AssetNode> _parseMasterNodeRows(List<dynamic> rows) {
    final nodes = <AssetNode>[];
    for (final row in rows) {
      try {
        if (row is! Map) continue;
        nodes.add(
          AssetNode.fromJson(
            row is Map<String, dynamic>
                ? row
                : Map<String, dynamic>.from(row),
          ),
        );
      } catch (_) {
        // skip malformed row
      }
    }
    return nodes;
  }

  Future<List<AssetNode>> _fetchStagingAssets(Set<String> ownMrids) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/assets/staging',
    );
    final assets = response.data?['assets'] as List<dynamic>? ?? [];
    return assets.map((row) {
      final map = row as Map<String, dynamic>;
      final mrid = map['mrid'] as String;
      return AssetNode.fromStagingJson(
        map,
        isOwnCapture: ownMrids.contains(mrid),
      );
    }).toList();
  }

  Future<FieldSubmitResult> submitFieldNode({
    required String name,
    required double longitude,
    required double latitude,
    String operatingUtility = 'ECG_SOUTHERN',
    AssetKind assetKind = AssetKind.poleLv,
    String? substationName,
    String? boundaryFeederId,
    String? workOrderId,
    String? photoUrl,
    String? h3Index,
    bool enforceHexAssignment = false,
    String? mrid,
    String? offlineSessionStartedAt,
    String? operatorId,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '$_syncUrl/api/v1/field/nodes',
        data: {
          'name': name,
          'longitude': longitude,
          'latitude': latitude,
          'operating_utility': operatingUtility,
          'asset_kind': assetKindToApiValue(assetKind),
          if (substationName != null) 'substation_name': substationName,
          if (boundaryFeederId != null) 'boundary_feeder_id': boundaryFeederId,
          if (workOrderId != null) 'work_order_id': workOrderId,
          if (photoUrl != null) 'photo_url': photoUrl,
          if (h3Index != null) 'h3_index': h3Index,
          'enforce_hex_assignment': enforceHexAssignment,
          if (mrid != null) 'mrid': mrid,
          if (offlineSessionStartedAt != null)
            'offline_session_started_at': offlineSessionStartedAt,
          if (operatorId != null) 'operator_id': operatorId,
        },
        options: Options(contentType: 'application/json'),
      );
      final data = response.data ?? {};
      return FieldSubmitResult(success: true, mrid: data['mrid'] as String?);
    } on DioException catch (e) {
      if (e.response?.statusCode == 409) {
        final data = e.response?.data;
        if (data is Map<String, dynamic>) {
          return FieldSubmitResult(
            success: false,
            conflict: true,
            conflictId: data['conflict_id'] as String?,
            mrid: data['asset_mrid'] as String?,
            message: data['detail'] as String?,
          );
        }
      }
      rethrow;
    }
  }

  Future<SnapPointResult> fetchSnapPoint({
    required double latitude,
    required double longitude,
    double snapM = 15,
  }) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/field/snap-point',
      queryParameters: {
        'lat': latitude,
        'lng': longitude,
        'snap_m': snapM,
      },
    );
    return SnapPointResult.fromJson(response.data ?? {});
  }

  Future<List<NearbyAssetHit>> fetchNearbyCheck({
    required double latitude,
    required double longitude,
    double radiusM = 5,
  }) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/field/nearby-check',
      queryParameters: {
        'lat': latitude,
        'lng': longitude,
        'radius_m': radiusM,
      },
    );
    final hits = response.data?['hits'] as List<dynamic>? ?? [];
    return hits
        .map((e) => NearbyAssetHit.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<List<String>> fetchFeederLookup({String? q}) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/field/lookup/feeders',
      queryParameters: {if (q != null && q.isNotEmpty) 'q': q},
    );
    final list = response.data?['feeders'] as List<dynamic>? ?? [];
    return list.map((e) => e.toString()).toList();
  }

  Future<List<String>> fetchSubstationLookup({String? q}) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/field/lookup/substations',
      queryParameters: {if (q != null && q.isNotEmpty) 'q': q},
    );
    final list = response.data?['substations'] as List<dynamic>? ?? [];
    return list.map((e) => e.toString()).toList();
  }

  Future<String?> fetchH3CellAt({
    required double latitude,
    required double longitude,
  }) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/h3/cell-at',
      queryParameters: {'lat': latitude, 'lng': longitude},
    );
    return response.data?['h3'] as String? ?? response.data?['index'] as String?;
  }

  Future<String> uploadFieldPhoto(File file) async {
    final formData = FormData.fromMap({
      'file': await MultipartFile.fromFile(
        file.path,
        filename: file.path.split('/').last,
      ),
    });
    final response = await _dio.post<Map<String, dynamic>>(
      '$_syncUrl/api/v1/field/photos',
      data: formData,
    );
    final url = response.data?['photo_url'] as String?;
    if (url == null || url.isEmpty) {
      throw StateError('Upload failed');
    }
    if (url.startsWith('/')) {
      return '$_syncUrl$url';
    }
    return url;
  }

  Future<FieldSubmitResult> submitFieldSpan({
    required String sourceNodeId,
    required String targetNodeId,
    String? boundaryFeederId,
    String? workOrderId,
    String? name,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '$_syncUrl/api/v1/field/spans',
      data: {
        'source_node_id': sourceNodeId,
        'target_node_id': targetNodeId,
        if (boundaryFeederId != null) 'boundary_feeder_id': boundaryFeederId,
        if (workOrderId != null) 'work_order_id': workOrderId,
        if (name != null) 'name': name,
        'operator_id': operatorId,
      },
      options: Options(contentType: 'application/json'),
    );
    return FieldSubmitResult(success: true, mrid: response.data?['mrid'] as String?);
  }

  Future<List<StagingSpan>> fetchStagingSpans() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/assets/staging/spans',
    );
    final spans = response.data?['spans'] as List<dynamic>? ?? [];
    return spans
        .map((e) => StagingSpan.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<Map<String, dynamic>> runMeterOcr(File imageFile) async {
    final formData = FormData.fromMap({
      'file': await MultipartFile.fromFile(
        imageFile.path,
        filename: imageFile.path.split('/').last,
      ),
    });
    final response = await _dio.post<Map<String, dynamic>>(
      '${config.ocrBaseUrl}/api/v1/meter/ocr',
      data: formData,
    );
    return response.data ?? {};
  }

  Future<void> submitFieldLocation({
    required double longitude,
    required double latitude,
    double? accuracyM,
    double? headingDeg,
    double? speedMps,
    String? workOrderId,
  }) async {
    await _dio.post(
      '$_syncUrl/api/v1/field/location',
      data: {
        'technician_id': config.technicianId,
        'longitude': longitude,
        'latitude': latitude,
        if (config.technicianDisplayName != null)
          'display_name': config.technicianDisplayName,
        if (accuracyM != null) 'accuracy_m': accuracyM,
        if (headingDeg != null) 'heading_deg': headingDeg,
        if (speedMps != null) 'speed_mps': speedMps,
        if (workOrderId != null) 'work_order_id': workOrderId,
        'session_started_at': DateTime.now().toUtc().toIso8601String(),
      },
      options: Options(contentType: 'application/json'),
    );
  }

  String get operatorId => config.technicianId;

  /// Bulk-download adjacency for nearby master nodes into SQLite.
  Future<int> prefetchConnectionsForNodes(
    List<String> mrids, {
    double? nearLat,
    double? nearLon,
    int maxNodes = 80,
  }) async {
    var unique = mrids.where((m) => m.isNotEmpty).toSet().toList();
    if (unique.isEmpty) return 0;

    if (nearLat != null &&
        nearLon != null &&
        nearLat.isFinite &&
        nearLon.isFinite &&
        unique.length > maxNodes) {
      // Nodes are already distance-sorted when loaded via nodes_near_location.
      unique = unique.take(maxNodes).toList();
    } else if (unique.length > maxNodes) {
      unique = unique.take(maxNodes).toList();
    }

    const chunkSize = 25;
    var cachedCount = 0;

    for (var offset = 0; offset < unique.length; offset += chunkSize) {
      final end = offset + chunkSize > unique.length
          ? unique.length
          : offset + chunkSize;
      final chunk = unique.sublist(offset, end);
      final chunkMap = <String, dynamic>{};
      try {
        final response = await _dio.post<Map<String, dynamic>>(
          '$_syncUrl/api/v1/nodes/connections/bulk',
          data: {
            'mrids': chunk,
            'limit_per_node': 25,
          },
          options: Options(
            receiveTimeout: const Duration(seconds: 30),
            sendTimeout: const Duration(seconds: 15),
            contentType: 'application/json',
          ),
        );
        final data = response.data;
        final connections = data?['connections'];
        if (connections is Map) {
          for (final entry in connections.entries) {
            chunkMap[entry.key.toString()] = entry.value;
          }
        }
      } on DioException {
        continue;
      }

      if (chunkMap.isNotEmpty) {
        await OfflineDb.cacheNodeTopologyBatch(chunkMap);
        cachedCount += chunkMap.length;
      }
    }

    return cachedCount;
  }

  Future<Map<String, dynamic>?> fetchNodeConnections(String mrid) async {
    final cached = await OfflineDb.getCachedNodeTopology(mrid);
    if (cached != null) return cached;

    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '$_syncUrl/api/v1/nodes/$mrid/connections',
        queryParameters: {'limit': 25},
        options: Options(
          receiveTimeout: const Duration(seconds: 20),
          connectTimeout: const Duration(seconds: 10),
        ),
      );
      final data = response.data;
      if (data != null) {
        await OfflineDb.upsertNodeTopology(mrid, data);
        return data;
      }
    } on DioException catch (e) {
      if (config.preferSyncOnly) {
        throw Exception('Connection lookup failed: ${_shortError(e)}');
      }
    }

    if (config.preferSyncOnly) return null;

    try {
      final response = await _dio.post<dynamic>(
        '${config.supabaseUrl}/rest/v1/rpc/node_connections',
        data: {'p_mrid': mrid, 'p_limit': 25},
        options: Options(
          headers: _supabaseHeaders,
          receiveTimeout: const Duration(seconds: 8),
          sendTimeout: const Duration(seconds: 8),
        ),
      );
      final raw = response.data;
      if (raw is Map<String, dynamic>) {
        await OfflineDb.upsertNodeTopology(mrid, raw);
        return raw;
      }
      if (raw is String) {
        final decoded = jsonDecode(raw);
        if (decoded is Map<String, dynamic>) {
          await OfflineDb.upsertNodeTopology(mrid, decoded);
          return decoded;
        }
      }
      return null;
    } on DioException catch (e) {
      final status = e.response?.statusCode;
      final detail = e.response?.data;
      throw Exception(
        'Topology lookup failed'
        '${status != null ? ' (HTTP $status)' : ''}'
        '${detail != null ? ': $detail' : ''}',
      );
    }
  }

  Future<void> submitTelemetry({
    required String meterMrid,
    required double activeEnergyKwh,
  }) async {
    await _dio.post(
      '$_syncUrl/api/v1/telemetry/submit',
      data: {
        'meter_mrid': meterMrid,
        'active_energy_kwh': activeEnergyKwh,
      },
      options: Options(contentType: 'application/json'),
    );
  }

  Future<void> submitSpotBill({
    required String accountMrid,
    required double previousReadingKwh,
    required double currentReadingKwh,
    String? meterMrid,
    String? evidencePhotoUrl,
    double? tariffRateGhs,
  }) async {
    await _dio.post(
      '$_syncUrl/api/v1/m2c/spot-bill-sync',
      data: {
        'account_mrid': accountMrid,
        'previous_reading_kwh': previousReadingKwh,
        'current_reading_kwh': currentReadingKwh,
        if (meterMrid != null) 'meter_mrid': meterMrid,
        if (evidencePhotoUrl != null) 'evidence_photo_url': evidencePhotoUrl,
        if (tariffRateGhs != null) 'tariff_rate_ghs': tariffRateGhs,
      },
      options: Options(contentType: 'application/json'),
    );
  }

  /// Pull work orders assigned to [user] or [crew] and cache locally.
  Future<List<Map<String, dynamic>>> fetchAssignedWorkOrders({
    String? user,
    String? crew,
  }) async {
    final effectiveUser = user ?? 'tech.demo';
    final query = crew != null ? 'crew=${Uri.encodeComponent(crew)}' : 'user=${Uri.encodeComponent(effectiveUser)}';
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/work-orders/assigned?$query',
    );
    final list = response.data?['work_orders'];
    final orders = list is List
        ? list.map((e) => Map<String, dynamic>.from(e as Map)).toList()
        : <Map<String, dynamic>>[];
    await OfflineDb.upsertWorkOrders(orders);
    return orders;
  }

  Future<void> patchWorkOrderStatus({
    required String workOrderId,
    required String status,
    String? notes,
  }) async {
    await _dio.patch(
      '$_syncUrl/api/v1/work-orders/$workOrderId',
      data: {
        'status': status,
        if (notes != null) 'notes': notes,
        'operator_id': 'tech.demo',
      },
      options: Options(contentType: 'application/json'),
    );
  }

  /// Push queued status updates then refresh assigned work orders.
  Future<void> syncWorkOrders({String? user}) async {
    final pending = await OfflineDb.pendingWorkOrderStatusUpdates();
    for (final row in pending) {
      final queueId = row['id'] as int;
      final woId = row['work_order_id'] as String;
      final newStatus = row['new_status'] as String;
      final notes = row['notes'] as String?;
      try {
        await patchWorkOrderStatus(
          workOrderId: woId,
          status: newStatus,
          notes: notes,
        );
        await OfflineDb.markWorkOrderStatusUpdateSynced(queueId, woId);
      } catch (_) {
        // keep queued for next sync
      }
    }
    await fetchAssignedWorkOrders(user: user ?? config.technicianId);
  }

  Future<List<FieldNotification>> fetchUndeliveredNotifications() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/field/notifications',
      queryParameters: {
        'technician_id': config.technicianId,
        'undelivered_only': true,
        'limit': 50,
      },
    );
    final list = response.data?['notifications'];
    if (list is! List) return const [];
    return list
        .map((e) => FieldNotification.fromJson(Map<String, dynamic>.from(e as Map)))
        .where((n) => n.messageType == 'ASSET_REJECTED')
        .toList();
  }

  Future<void> markNotificationDelivered(String notificationId) async {
    await _dio.post(
      '$_syncUrl/api/v1/field/notifications/$notificationId/delivered',
    );
  }

  Future<void> markNotificationRead(String notificationId) async {
    await _dio.post(
      '$_syncUrl/api/v1/field/notifications/$notificationId/read',
      queryParameters: {'technician_id': config.technicianId},
    );
  }

  Future<List<TechnicianSubmission>> fetchMySubmissions() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_syncUrl/api/v1/field/technicians/${Uri.encodeComponent(config.technicianId)}/submissions',
      queryParameters: {'limit': 100},
    );
    final list = response.data?['submissions'];
    if (list is! List) return const [];
    return list
        .map((e) => TechnicianSubmission.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }
}
