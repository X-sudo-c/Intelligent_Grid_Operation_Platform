import 'dart:math' as math;

import 'package:dio/dio.dart';

import 'package:latlong2/latlong.dart';

import '../config/api_config.dart';
import 'offline_db.dart';

/// Prefetch Martin vector tiles for the active viewport (bounded LRU in [OfflineDb]).
class TileCacheService {
  TileCacheService(this.config) : _dio = Dio();

  final ApiConfig config;
  final Dio _dio;

  static const _layerIds = [
    'map_ac_line_segments',
    'map_connectivity_nodes',
    'distribution_transformer',
  ];

  Future<void> prefetchViewport({
    required double latitude,
    required double longitude,
    required double zoom,
  }) async {
    final z = zoom.floor().clamp(10, 16);
    final n = math.pow(2, z).toInt();
    final latRad = latitude * math.pi / 180;
    final x = ((longitude + 180) / 360 * n).floor();
    final y =
        ((1 - math.log(math.tan(latRad) + 1 / math.cos(latRad)) / math.pi) / 2 * n)
            .floor();

    for (final layerId in _layerIds) {
      for (final dx in [-1, 0, 1]) {
        for (final dy in [-1, 0, 1]) {
          final tx = x + dx;
          final ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
          final cached = await OfflineDb.loadCachedTile(
            z: z,
            x: tx,
            y: ty,
            layerId: layerId,
          );
          if (cached != null) continue;
          try {
            final url =
                '${config.martinBaseUrl}/$layerId/$z/$tx/$ty';
            final response = await _dio.get<List<int>>(
              url,
              options: Options(responseType: ResponseType.bytes),
            );
            final bytes = response.data;
            if (bytes == null || bytes.isEmpty) continue;
            await OfflineDb.cacheTile(
              z: z,
              x: tx,
              y: ty,
              layerId: layerId,
              pbfBytes: bytes,
            );
          } catch (_) {
            // Martin may be offline; cache is best-effort.
          }
        }
      }
    }
  }

  Future<void> prefetchForBounds(List<LatLng> points, {int zoom = 14}) async {
    if (points.isEmpty) return;
    var minLat = points.first.latitude;
    var maxLat = points.first.latitude;
    var minLon = points.first.longitude;
    var maxLon = points.first.longitude;
    for (final p in points) {
      minLat = math.min(minLat, p.latitude);
      maxLat = math.max(maxLat, p.latitude);
      minLon = math.min(minLon, p.longitude);
      maxLon = math.max(maxLon, p.longitude);
    }
    final center = LatLng((minLat + maxLat) / 2, (minLon + maxLon) / 2);
    await prefetchViewport(
      latitude: center.latitude,
      longitude: center.longitude,
      zoom: zoom.toDouble(),
    );
    await prefetchViewport(
      latitude: minLat,
      longitude: minLon,
      zoom: zoom.toDouble(),
    );
    await prefetchViewport(
      latitude: maxLat,
      longitude: maxLon,
      zoom: zoom.toDouble(),
    );
  }
}
