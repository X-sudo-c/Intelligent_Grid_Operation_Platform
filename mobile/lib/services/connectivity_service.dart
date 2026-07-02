import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';

import '../config/api_config.dart';

/// Link + sync-service reachability for auto-sync, map status, and field tracking.
class ConnectivityService {
  ConnectivityService._();

  static final ConnectivityService instance = ConnectivityService._();

  final _connectivity = Connectivity();
  final _linkController = StreamController<bool>.broadcast();
  final _apiReachableController = StreamController<bool>.broadcast();

  bool _linkUp = true;
  bool _apiReachable = false;
  String? _syncBaseUrl;
  Timer? _probeTimer;
  Future<void>? _probeInFlight;

  /// Wi‑Fi / cellular link present (does not verify sync-service).
  Stream<bool> get linkStream => _linkController.stream;
  bool get lastLinkUp => _linkUp;

  /// Sync-service responded to a lightweight health probe.
  Stream<bool> get apiReachableStream => _apiReachableController.stream;
  bool get lastApiReachable => _apiReachable;

  /// True when the device has a link and sync-service is reachable.
  bool get lastOnline => _linkUp && _apiReachable;

  /// Back-compat: same as [lastOnline].
  Stream<bool> get onlineStream => _apiReachableController.stream.map((_) => lastOnline);

  StreamSubscription<List<ConnectivityResult>>? _sub;

  void configureSyncProbe(String syncBaseUrl) {
    final normalized = ApiConfig.normalizeBaseUrl(syncBaseUrl);
    if (_syncBaseUrl == normalized) return;
    _syncBaseUrl = normalized;
    unawaited(probeSyncNow());
    _probeTimer ??= Timer.periodic(const Duration(seconds: 25), (_) {
      unawaited(probeSyncNow());
    });
  }

  Future<void> start({String? syncBaseUrl}) async {
    final initial = await _connectivity.checkConnectivity();
    _emitLink(initial);
    _sub ??= _connectivity.onConnectivityChanged.listen(_emitLink);
    if (syncBaseUrl != null && syncBaseUrl.isNotEmpty) {
      configureSyncProbe(syncBaseUrl);
    }
  }

  void _emitLink(List<ConnectivityResult> results) {
    final up = results.any((r) => r != ConnectivityResult.none);
    if (up == _linkUp) return;
    _linkUp = up;
    _linkController.add(up);
    if (up) {
      unawaited(probeSyncNow());
    } else {
      _setApiReachable(false);
    }
  }

  void _setApiReachable(bool reachable) {
    if (_apiReachable == reachable) return;
    _apiReachable = reachable;
    _apiReachableController.add(reachable);
  }

  /// Quick HEAD/GET to sync :5000 — used before field location pings.
  Future<bool> probeSyncNow() async {
    if (!_linkUp) {
      _setApiReachable(false);
      return false;
    }
    final base = _syncBaseUrl;
    if (base == null || base.isEmpty) {
      _setApiReachable(false);
      return false;
    }

    if (_probeInFlight != null) {
      await _probeInFlight;
      return _apiReachable;
    }

    _probeInFlight = _probeSync(base);
    try {
      await _probeInFlight;
    } finally {
      _probeInFlight = null;
    }
    return _apiReachable;
  }

  Future<void> _probeSync(String base) async {
    final uri = Uri.parse(
      '$base/api/v1/map/nodes?lat=${GiopApiDefaults.mapLat}&lon=${GiopApiDefaults.mapLon}&limit=1',
    );
    final client = HttpClient();
    client.connectionTimeout = const Duration(seconds: 4);
    try {
      final req = await client.getUrl(uri);
      final res = await req.close().timeout(const Duration(seconds: 5));
      await res.drain<void>();
      _setApiReachable(res.statusCode >= 200 && res.statusCode < 500);
    } catch (_) {
      _setApiReachable(false);
    } finally {
      client.close(force: true);
    }
  }

  Future<bool> checkOnline() async {
    final results = await _connectivity.checkConnectivity();
    _emitLink(results);
    if (!_linkUp) return false;
    return probeSyncNow();
  }

  void dispose() {
    _probeTimer?.cancel();
    _sub?.cancel();
    _linkController.close();
    _apiReachableController.close();
  }
}

/// Shared map probe coordinates (Accra area).
abstract final class GiopApiDefaults {
  static const mapLat = 5.6037;
  static const mapLon = -0.187;
}
