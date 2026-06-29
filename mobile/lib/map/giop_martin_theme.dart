import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:vector_map_tiles/vector_map_tiles.dart';
import 'package:vector_tile_renderer/vector_tile_renderer.dart';

import '../debug_agent_log.dart';

/// Martin vector-tile theme + providers matching the portal Network Map.
abstract final class GiopMartinTheme {
  // Martin serves line/node tiles with data up to z16; library overzooms above that.
  static const _maxZoom = 16;

  // Parsed theme / providers are immutable and expensive to build, so cache them
  // per Martin base URL. Without this, GiopGridVectorLayer.build re-parses the
  // whole theme (JSON + expression parsers) on every map rebuild, saturating the
  // UI thread and causing tile loads to be cancelled (lines vanishing).
  static Theme? _cachedTheme;
  static final Map<String, TileProviders> _cachedProviders = {};
  static const _themeVersion = 2;

  static String _tileUrl(String base, String layer) =>
      '${base.replaceAll(RegExp(r'/+$'), '')}/$layer/{z}/{x}/{y}';

  static GiopMartinTileProvider _provider(String base, String layer) {
    return GiopMartinTileProvider(
      urlTemplate: _tileUrl(base, layer),
      maximumZoom: _maxZoom,
      layerName: layer,
      martinHost: Uri.tryParse(base)?.host,
    );
  }

  static TileProviders tileProviders(String martinBaseUrl) {
    final base = martinBaseUrl.replaceAll(RegExp(r'/+$'), '');
    return _cachedProviders.putIfAbsent(
        base,
        () => TileProviders({
          'oh_conductor_33kv': _provider(base, 'oh_conductor_33kv'),
          'oh_conductor_11kv': _provider(base, 'oh_conductor_11kv'),
          'ug_cable_33kv': _provider(base, 'ug_cable_33kv'),
          'ug_cable_11kv': _provider(base, 'ug_cable_11kv'),
          'map_ac_line_segments': _provider(base, 'map_ac_line_segments'),
          'map_connectivity_nodes': _provider(base, 'map_connectivity_nodes'),
          'distribution_transformer':
              _provider(base, 'distribution_transformer'),
          'power_transformer': _provider(base, 'power_transformer'),
        }));
  }

  static Theme readGridTheme() {
    final cached = _cachedTheme;
    if (cached != null) {
      return cached;
    }
    final theme = ThemeReader().read(_themeJson);
    _cachedTheme = theme;
    // #region agent log
    agentLog(
      location: 'giop_martin_theme.dart:readGridTheme',
      message: 'theme parsed once and cached',
      hypothesisId: 'H7',
      runId: 'post-fix-3',
      data: {
        'layerCount': theme.layers.length,
        'lineLayerCount':
            theme.layers.where((l) => l.type == ThemeLayerType.line).length,
      },
    );
    // #endregion
    return theme;
  }

  static const _voltageLineColor = [
    'match',
    ['get', 'nominal_voltage'],
    'HV_161KV',
    '#78350F',
    'HV_330KV',
    '#78350F',
    'MV_33KV',
    '#1D4ED8',
    'MV_11KV',
    '#B91C1C',
    'LV_230V',
    '#0F172A',
    'LV_400V',
    '#0F172A',
    '#64748B',
  ];

  static final Map<String, dynamic> _themeJson = {
    'id': 'giop-field-grid',
    'metadata': {'version': '$_themeVersion'},
    'layers': [
      {
        'id': 'overview-oh-33kv',
        'type': 'line',
        'source': 'oh_conductor_33kv',
        'source-layer': 'oh_conductor_33kv',
        'minzoom': 10,
        'maxzoom': 14,
        'paint': {
          'line-color': '#1D4ED8',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            7,
            1.05,
            9,
            1.35,
            11,
            1.6,
            12,
            1.9,
            14,
            2.2,
          ],
          'line-opacity': 0.88,
        },
      },
      {
        'id': 'overview-oh-11kv',
        'type': 'line',
        'source': 'oh_conductor_11kv',
        'source-layer': 'oh_conductor_11kv',
        'minzoom': 10,
        'maxzoom': 14,
        'paint': {
          'line-color': '#B91C1C',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            1.05,
            9,
            1.35,
            11,
            1.6,
            12,
            1.9,
          ],
          'line-opacity': 0.88,
        },
      },
      {
        'id': 'overview-ug-33kv',
        'type': 'line',
        'source': 'ug_cable_33kv',
        'source-layer': 'ug_cable_33kv',
        'minzoom': 10,
        'maxzoom': 14,
        'paint': {
          'line-color': '#1D4ED8',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            1.05,
            9,
            1.35,
            11,
            1.6,
            12,
            1.9,
            14,
            2.2,
          ],
          'line-opacity': 0.75,
          'line-dasharray': [4, 3],
        },
      },
      {
        'id': 'overview-ug-11kv',
        'type': 'line',
        'source': 'ug_cable_11kv',
        'source-layer': 'ug_cable_11kv',
        'minzoom': 10,
        'maxzoom': 14,
        'paint': {
          'line-color': '#B91C1C',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            1.05,
            9,
            1.35,
            11,
            1.6,
            12,
            1.9,
          ],
          'line-opacity': 0.75,
          'line-dasharray': [4, 3],
        },
      },
      {
        'id': 'detail-lines-overhead-mv',
        'type': 'line',
        'source': 'map_ac_line_segments',
        'source-layer': 'map_ac_line_segments',
        'minzoom': 8,
        'filter': [
          'all',
          ['!in', 'nominal_voltage', 'LV_230V', 'LV_400V'],
          ['!=', 'installation_type', 'UNDERGROUND'],
        ],
        'paint': {
          'line-color': _voltageLineColor,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            0.6,
            11,
            0.9,
            12,
            1.2,
            15,
            2.5,
          ],
          'line-opacity': 0.92,
        },
      },
      {
        'id': 'detail-lines-underground-mv',
        'type': 'line',
        'source': 'map_ac_line_segments',
        'source-layer': 'map_ac_line_segments',
        'minzoom': 8,
        'filter': [
          'all',
          ['!in', 'nominal_voltage', 'LV_230V', 'LV_400V'],
          ['==', 'installation_type', 'UNDERGROUND'],
        ],
        'paint': {
          'line-color': _voltageLineColor,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            0.6,
            11,
            0.9,
            12,
            1.2,
            15,
            2.5,
          ],
          'line-opacity': 0.92,
          'line-dasharray': [4, 3],
        },
      },
      {
        'id': 'detail-lines-overhead-lv',
        'type': 'line',
        'source': 'map_ac_line_segments',
        'source-layer': 'map_ac_line_segments',
        'minzoom': 8,
        'filter': [
          'all',
          ['in', 'nominal_voltage', 'LV_230V', 'LV_400V'],
          ['!=', 'installation_type', 'UNDERGROUND'],
        ],
        'paint': {
          'line-color': '#0F172A',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            0.5,
            11,
            1.0,
            14,
            1.8,
            16,
            2.4,
          ],
          'line-opacity': 0.85,
        },
      },
      {
        'id': 'detail-lines-underground-lv',
        'type': 'line',
        'source': 'map_ac_line_segments',
        'source-layer': 'map_ac_line_segments',
        'minzoom': 8,
        'filter': [
          'all',
          ['in', 'nominal_voltage', 'LV_230V', 'LV_400V'],
          ['==', 'installation_type', 'UNDERGROUND'],
        ],
        'paint': {
          'line-color': '#0F172A',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            0.5,
            11,
            1.0,
            14,
            1.8,
            16,
            2.4,
          ],
          'line-opacity': 0.85,
          'line-dasharray': [4, 3],
        },
      },
      {
        'id': 'detail-nodes',
        'type': 'circle',
        'source': 'map_connectivity_nodes',
        'source-layer': 'map_connectivity_nodes',
        'minzoom': 11.5,
        'paint': {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11.5,
            1.2,
            12,
            1.6,
            13,
            2.2,
            15,
            3.5,
          ],
          'circle-color': '#64748B',
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11.5,
            0.2,
            15,
            1.2,
          ],
          'circle-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11.5,
            0.45,
            12,
            0.62,
            15,
            0.9,
          ],
        },
      },
      {
        'id': 'distribution-transformers',
        'type': 'circle',
        'source': 'distribution_transformer',
        'source-layer': 'distribution_transformer',
        'minzoom': 12,
        'paint': {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            1.8,
            14,
            2.4,
            16,
            3.0,
          ],
          'circle-color': '#E65100',
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': 1,
          'circle-opacity': 0.95,
        },
      },
      {
        'id': 'power-transformers',
        'type': 'circle',
        'source': 'power_transformer',
        'source-layer': 'power_transformer',
        'minzoom': 10,
        'paint': {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            1.8,
            12,
            2.2,
            14,
            3.2,
          ],
          'circle-color': '#7C3AED',
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': 1,
          'circle-opacity': 0.95,
        },
      },
    ],
  };
}

const _martinGridLayers = [
  'map_connectivity_nodes',
  'map_ac_line_segments',
  'oh_conductor_33kv',
  'oh_conductor_11kv',
];

/// Ghana grid centroid (Roman Ridge) — used to verify Martin serves real data.
const giopGridProbeLat = 5.6037;
const giopGridProbeLon = -0.187;

int _tileX(double lon, int z) => ((lon + 180) / 360 * (1 << z)).floor();

int _tileY(double lat, int z) {
  final latRad = lat * math.pi / 180;
  return ((1 -
              math.log(math.tan(latRad) + 1 / math.cos(latRad)) / math.pi) /
          2 *
      (1 << z))
      .floor();
}

/// Martin returns 204 for empty tiles; the stock provider only accepts 200.
class GiopMartinTileProvider extends NetworkVectorTileProvider {
  GiopMartinTileProvider({
    required super.urlTemplate,
    super.maximumZoom,
    super.minimumZoom,
    this.layerName = 'unknown',
    this.martinHost,
  });

  final String layerName;
  final String? martinHost;
  static int _tileLogCount = 0;
  static final _loggedTiles = <String>{};

  bool get _isLineLayer =>
      layerName.contains('line') ||
      layerName.contains('conductor') ||
      layerName.contains('cable');

  @override
  Future<Uint8List> provide(TileIdentity tile) async {
    try {
      final bytes = await super.provide(tile);
      // #region agent log
      if (_isLineLayer) {
        final key = '$layerName:${tile.z}:${tile.x}:${tile.y}';
        if (_loggedTiles.add(key) && _tileLogCount < 40) {
          _tileLogCount++;
          agentLog(
            location: 'giop_martin_theme.dart:provide',
            message: 'line tile ok',
            hypothesisId: 'H6',
            runId: 'post-fix-3',
            ingestHost: martinHost,
            data: {
              'layer': layerName,
              'z': tile.z,
              'x': tile.x,
              'y': tile.y,
              'bytes': bytes.length,
            },
          );
        }
      }
      // #endregion
      return bytes;
    } on ProviderException catch (e) {
      // #region agent log
      if (_isLineLayer) {
        final key = 'err:$layerName:${tile.z}:${tile.x}:${tile.y}';
        if (_loggedTiles.add(key) && _tileLogCount < 40) {
          _tileLogCount++;
          agentLog(
            location: 'giop_martin_theme.dart:provide',
            message: 'line tile error',
            hypothesisId: 'H6',
            runId: 'post-fix-3',
            ingestHost: martinHost,
            data: {
              'layer': layerName,
              'z': tile.z,
              'x': tile.x,
              'y': tile.y,
              'status': e.statusCode,
              'err': e.message,
            },
          );
        }
      }
      // #endregion
      if (e.statusCode == 204) return Uint8List(0);
      rethrow;
    }
  }
}

/// Is Martin up and publishing the grid tilesets the portal uses?
Future<bool> probeMartinReachable(String martinBaseUrl) async {
  final base = martinBaseUrl.replaceAll(RegExp(r'/+$'), '');
  final ingestHost = hostFromUrl(base);
  final client = HttpClient();
  var catalogOk = false;
  var nodeTileBytes = 0;
  var lineTileBytes = 0;
  var lineTileStatus = 0;
  try {
    final request = await client.getUrl(Uri.parse('$base/catalog'));
    final response = await request.close().timeout(const Duration(seconds: 6));
    catalogOk = response.statusCode == 200;
    if (!catalogOk) {
      // #region agent log
      agentLog(
        location: 'giop_martin_theme.dart:probe',
        message: 'catalog fail',
        hypothesisId: 'H2',
        ingestHost: ingestHost,
        data: {'martinBaseUrl': base, 'status': response.statusCode},
      );
      // #endregion
      return false;
    }
    final body = await response.transform(utf8.decoder).join();
    final decoded = jsonDecode(body);
    final ids = <String>{};
    if (decoded is List) {
      for (final item in decoded) {
        if (item is String) {
          ids.add(item);
        } else if (item is Map && item['id'] is String) {
          ids.add(item['id'] as String);
        }
      }
    } else if (decoded is Map) {
      ids.addAll(decoded.keys.cast<String>());
    }
    if (!_martinGridLayers.every(ids.contains)) {
      // #region agent log
      agentLog(
        location: 'giop_martin_theme.dart:probe',
        message: 'catalog missing layers',
        hypothesisId: 'H2',
        ingestHost: ingestHost,
        data: {'martinBaseUrl': base, 'ids': ids.toList()},
      );
      // #endregion
      return false;
    }

    final z = 14;
    final x = _tileX(giopGridProbeLon, z);
    final y = _tileY(giopGridProbeLat, z);
    final tileReq = await client.getUrl(
      Uri.parse('$base/map_connectivity_nodes/$z/$x/$y'),
    );
    final tileRes = await tileReq.close().timeout(const Duration(seconds: 8));
    if (tileRes.statusCode == 200) {
      await for (final chunk in tileRes) {
        nodeTileBytes += chunk.length;
        if (nodeTileBytes > 50) break;
      }
    }

    final lineReq = await client.getUrl(
      Uri.parse('$base/map_ac_line_segments/$z/$x/$y'),
    );
    final lineRes = await lineReq.close().timeout(const Duration(seconds: 8));
    lineTileStatus = lineRes.statusCode;
    if (lineRes.statusCode == 200) {
      await for (final chunk in lineRes) {
        lineTileBytes += chunk.length;
      }
    }

    final ok = nodeTileBytes > 50;
    // #region agent log
    agentLog(
      location: 'giop_martin_theme.dart:probe',
      message: 'probe complete',
      hypothesisId: 'H2',
      ingestHost: ingestHost,
      data: {
        'martinBaseUrl': base,
        'nodeTileBytes': nodeTileBytes,
        'lineTileStatus': lineTileStatus,
        'lineTileBytes': lineTileBytes,
        'probeOk': ok,
      },
    );
    // #endregion
    return ok;
  } catch (e) {
    // #region agent log
    agentLog(
      location: 'giop_martin_theme.dart:probe',
      message: 'probe exception',
      hypothesisId: 'H2',
      ingestHost: ingestHost,
      data: {'martinBaseUrl': base, 'err': e.toString()},
    );
    // #endregion
    return false;
  } finally {
    client.close(force: true);
  }
}
