import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_compass/flutter_compass.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../debug_agent_log.dart';
import '../map/giop_martin_theme.dart';
import '../map/giop_sld_colors.dart';
import '../models/asset_kind.dart';
import '../models/asset_node.dart';
import '../models/hex_assignment.dart';
import '../models/highlight_line.dart';
import '../services/capture_service.dart';
import '../services/display_location.dart';
import '../services/field_map_refresh_bus.dart';
import '../services/field_location_service.dart';
import '../services/giop_api.dart';
import '../services/heading_fusion_service.dart';
import '../services/navigation_camera.dart';
import '../services/navigation_location_settings.dart';
import '../services/offline_db.dart';
import '../services/tile_cache_service.dart';
import '../utils/geo.dart';
import '../models/capture_prefill.dart';
import '../services/capture_preferences.dart';
import '../services/connectivity_service.dart';
import '../services/field_map_fly_bus.dart';
import '../services/field_user_preferences.dart';
import '../screens/sync_queue_screen.dart';
import '../widgets/field_capture_sheet.dart';
import '../widgets/field_search_sheet.dart';
import '../widgets/giop_map_legend.dart';
import '../widgets/layer_panel_sheet.dart';
import '../widgets/map_crosshair.dart';
import '../widgets/user_location_marker.dart';

enum MapTool { pan, addPoint, drawSpan, measure }

class MapScreen extends StatefulWidget {
  const MapScreen({
    super.key,
    required this.api,
    this.refreshTrigger = 0,
    this.recapturePrefill,
    this.onRecaptureConsumed,
  });

  final GiopApi api;
  final int refreshTrigger;
  final CapturePrefill? recapturePrefill;
  final VoidCallback? onRecaptureConsumed;

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen>
    with WidgetsBindingObserver, TickerProviderStateMixin {
  final MapController _mapController = MapController();
  final LayerVisibility _layerVisibility = LayerVisibility();
  final Distance _distance = const Distance();

  List<AssetNode> _nodes = [];
  String? _selectedNodeMrid;
  List<HighlightLine> _highlightLines = [];
  String? _error;
  String? _loadIssue;
  bool _loading = false;
  bool _usingCache = false;
  bool _followMe = true;
  bool _headingUp = true;
  bool _userGesturing = false;
  int _activeMapPointers = 0;
  bool _syncing = false;
  int _pendingCount = 0;
  MapTool _tool = MapTool.pan;
  String? _spanSourceMrid;
  List<StagingSpan> _stagingSpans = const [];
  List<Map<String, dynamic>> _workOrders = const [];
  bool _showWorkOrders = true;
  bool _isOnline = true;
  bool _serverReachable = false;
  bool _linkUp = true;
  List<LatLng> _measurePoints = const [];
  LatLng? _stakeoutTarget;
  String? _stakeoutLabel;
  CapturePrefill? _pendingPrefill;
  Position? _position;
  double? _heading;
  double _headingConfidence = 0;
  double _mapRotationDeg = 0;
  final HeadingFusionService _headingFusion = HeadingFusionService();
  final NavigationCamera _navigationCamera = NavigationCamera();
  final DisplayLocation _displayLocation = DisplayLocation();
  StreamSubscription<Position>? _positionSub;
  StreamSubscription<CompassEvent>? _compassSub;
  StreamSubscription<MapEvent>? _mapEventSub;
  Ticker? _cameraTicker;
  Duration? _lastCameraElapsed;
  AnimationController? _toolCameraAnim;
  DateTime? _lastStatusBarHeadingUpdate;
  late final CaptureService _captureService;
  late final TileCacheService _tileCacheService;
  late FieldLocationService _fieldLocationService;
  static const _nodesRefetchMeters = 400.0;

  // --- H3 node streaming -----------------------------------------------------
  static const bool _h3Streaming = true;
  static const int _h3Res = 9;
  static const int _h3RingK = 1;
  static const double _nodeFetchMinZoom = 12.0;
  final Map<String, List<AssetNode>> _cellNodeCache = {};
  Set<String> _loadedCells = <String>{};
  Timer? _gpsFallbackTimer;
  DateTime? _gpsFixAt;

  // --- Assigned territory (H3 work scope) ------------------------------------
  List<HexAssignment> _assignments = const [];
  bool _showAssignments = true;
  bool _assignmentsLoading = false;
  int _assignmentLoadGeneration = 0;
  bool _hasFittedToAssignments = false;
  Timer? _assignmentsPollTimer;
  static const _assignmentsPollInterval = Duration(seconds: 20);

  int _nodesLoadGeneration = 0;
  LatLng? _lastNodesFetchAnchor;
  bool _programmaticCamera = false;
  bool _martinReachable = false;
  bool _martinGridLatched = false;
  bool _debugViewportLogged = false;
  final _loggedViewports = <String>{};
  int _viewportLogCount = 0;
  bool _hasFittedToGrid = false;
  Future<void>? _nodesLoadFuture;
  StreamSubscription<FieldMapDeltaRequest>? _mapDeltaSub;
  StreamSubscription<FieldMapFlyRequest>? _flySub;
  StreamSubscription<bool>? _connectivitySub;
  StreamSubscription<bool>? _linkSub;

  static const _defaultCenter = LatLng(5.6037, -0.1870);
  static const _snapMeters = 15.0;
  static const _identifyMeters = 30.0;
  static const _minZoom = 11.0;
  static const _maxZoom = 19.0;
  static const _followPanThresholdM = 3.0;
  static const _navPanThresholdM = 1.2;
  static const _addModeZoom = 17.0;
  static const _addModeFlyDuration = Duration(milliseconds: 550);

  bool get _hasValidPosition =>
      _position != null &&
      isFiniteLatLng(_position!.latitude, _position!.longitude);

  /// Uber/Bolt-style navigation: follow GPS + rotate map, puck fixed on screen.
  bool get _navigationMode =>
      _followMe && _headingUp && _tool == MapTool.pan;

  double _safeZoom([double? zoom]) {
    final z = zoom ?? _mapController.camera.zoom;
    if (!z.isFinite) return 16;
    return z.clamp(_minZoom, _maxZoom);
  }

  /// Vsync camera loop — navigation bearing smoothing + follow.
  void _onCameraTick(Duration elapsed) {
    if (!_hasValidPosition || !mounted) return;

    final dtSeconds = _lastCameraElapsed == null
        ? 1 / 60.0
        : (elapsed - _lastCameraElapsed!).inMicroseconds / 1e6;
    _lastCameraElapsed = elapsed;

    _displayLocation.setGpsTarget(
      LatLng(_position!.latitude, _position!.longitude),
      speedMps: _position!.speed,
      courseDeg: _headingFusion.heading ?? _position!.heading,
    );
    final moved = _displayLocation.tick();

    if (_navigationMode && !_userGesturing) {
      final bearing = _headingFusion.heading;
      if (bearing != null) {
        _navigationCamera.setBearingTarget(bearing);
        _navigationCamera.tick(dtSeconds: dtSeconds);
        _applyNavigationCameraFrame();
      }
      final now = DateTime.now();
      if (_lastStatusBarHeadingUpdate == null ||
          now.difference(_lastStatusBarHeadingUpdate!) >
              const Duration(milliseconds: 250)) {
        _lastStatusBarHeadingUpdate = now;
        setState(() {
          _heading = _headingFusion.heading;
          _headingConfidence = _headingFusion.confidence;
          _mapRotationDeg =
              _navigationCamera.displayRotationDeg ?? _mapRotationDeg;
        });
      }
    } else {
      if (_followMe && _tool == MapTool.pan && !_userGesturing) {
        _applyFollowCamera(center: _displayLocation.point);
      }
      if (moved) setState(() {});
    }
  }

  /// Apply smoothed navigation rotation + center (no feedback from camera.rotation).
  void _applyNavigationCameraFrame({double? zoom, bool snap = false}) {
    if (!_hasValidPosition || !_navigationMode || _userGesturing) return;

    if (snap) {
      final bearing = _headingFusion.heading;
      if (bearing != null) {
        _navigationCamera.setBearingTarget(bearing);
        _navigationCamera.snapToTarget();
      }
    }

    final rotation = _navigationCamera.displayRotationDeg;
    if (rotation == null || !rotation.isFinite) return;

    final mapCenter = _displayLocation.point ??
        LatLng(_position!.latitude, _position!.longitude);
    if (!isValidLatLng(mapCenter)) return;

    final current = _mapController.camera.center;
    final movedM = isValidLatLng(current)
        ? _distance.as(LengthUnit.Meter, current, mapCenter)
        : double.infinity;
    final speed = _position?.speed ?? 0;
    final panThreshold = speed > 1.2 ? 0.6 : _navPanThresholdM;
    final shouldMove = snap || movedM >= panThreshold;

    _programmaticCamera = true;
    try {
      final z = _safeZoom(zoom);
      if (shouldMove) {
        _mapController.moveAndRotate(mapCenter, z, rotation);
      } else {
        _mapController.rotate(rotation);
      }
    } finally {
      _programmaticCamera = false;
    }
  }

  void _cancelToolCameraAnim() {
    final anim = _toolCameraAnim;
    if (anim == null) return;
    _toolCameraAnim = null;
    anim.stop();
    anim.dispose();
    _programmaticCamera = false;
  }

  void _onMapPointerDown(PointerDownEvent event) {
    _cancelToolCameraAnim();
    _activeMapPointers++;
    if (_activeMapPointers == 1) {
      _userGesturing = true;
    }
  }

  void _onMapPointerUp(PointerEvent event) {
    _activeMapPointers = math.max(0, _activeMapPointers - 1);
    if (_activeMapPointers == 0) {
      // Let fling / inertia finish before resuming follow camera.
      Future<void>.delayed(const Duration(milliseconds: 120), () {
        if (!mounted || _activeMapPointers > 0) return;
        _userGesturing = false;
      });
    }
  }

  void _recoverMapCameraIfNeeded() {
    if (_userGesturing) return;
    final center = _mapController.camera.center;
    if (isValidLatLng(center)) return;
    final fallback = latLngIfValid(_position?.latitude, _position?.longitude) ??
        _defaultCenter;
    _programmaticCamera = true;
    try {
      _mapController.move(fallback, _safeZoom(16));
      _mapController.rotate(0);
      _mapRotationDeg = 0;
    } finally {
      _programmaticCamera = false;
    }
  }

  @override
  void initState() {
    super.initState();
    _captureService = CaptureService(widget.api);
    _fieldLocationService = FieldLocationService(widget.api);
    _tileCacheService = TileCacheService(widget.api.config);
    _mapEventSub = _mapController.mapEventStream.listen(_onMapUserEvent);
    _headingFusion.start();
    _headingFusion.setNavigationMode(true);
    _cameraTicker = createTicker(_onCameraTick)..start();
    _loadNodesFromCache();
    _scheduleGpsFallbackLoad();
    _probeMartinGrid();
    _startGps();
    _startCompass();
    _refreshPendingCount();
    _syncPending();
    _loadAssignments();
    WidgetsBinding.instance.addObserver(this);
    _assignmentsPollTimer = Timer.periodic(
      _assignmentsPollInterval,
      (_) => unawaited(_loadAssignments(force: true)),
    );
    _mapDeltaSub = FieldMapRefreshBus.instance.stream.listen((request) {
      unawaited(_refreshH3Delta(request));
    });
    _flySub = FieldMapFlyBus.instance.stream.listen((request) {
      _programmaticCamera = true;
      try {
        _mapController.move(
          LatLng(request.latitude, request.longitude),
          request.zoom.clamp(_minZoom, _maxZoom),
        );
        setState(() {
          _followMe = false;
          _stakeoutTarget = LatLng(request.latitude, request.longitude);
          _stakeoutLabel = request.label;
        });
      } finally {
        _programmaticCamera = false;
      }
    });
    unawaited(_bootstrapFieldPrefs());
    unawaited(_loadWorkOrders());
    void syncConnectivityState() {
      if (!mounted) return;
      setState(() {
        _linkUp = ConnectivityService.instance.lastLinkUp;
        _serverReachable = ConnectivityService.instance.lastApiReachable;
        _isOnline = ConnectivityService.instance.lastOnline;
      });
    }

    unawaited(ConnectivityService.instance.start(
      syncBaseUrl: widget.api.config.syncBaseUrl,
    ));
    syncConnectivityState();
    _linkSub = ConnectivityService.instance.linkStream.listen((_) {
      syncConnectivityState();
      if (ConnectivityService.instance.lastOnline) {
        final prefs = FieldUserPreferences.autoSyncOnConnect();
        prefs.then((auto) {
          if (auto && mounted) _syncPending();
        });
      }
    });
    _connectivitySub = ConnectivityService.instance.apiReachableStream.listen((_) {
      syncConnectivityState();
      if (ConnectivityService.instance.lastOnline) {
        final prefs = FieldUserPreferences.autoSyncOnConnect();
        prefs.then((auto) {
          if (auto && mounted) _syncPending();
        });
      }
    });
    unawaited(_loadStagingSpans());
  }

  Future<void> _bootstrapFieldPrefs() async {
    final showWo = await FieldUserPreferences.showWorkOrdersOnMap();
    final showAssign = await FieldUserPreferences.showAssignmentsDefault();
    if (!mounted) return;
    setState(() {
      _showWorkOrders = showWo;
      _showAssignments = showAssign;
    });
  }

  Future<void> _loadWorkOrders() async {
    try {
      await widget.api.syncWorkOrders();
    } catch (_) {}
    final rows = await OfflineDb.listWorkOrders();
    if (mounted) setState(() => _workOrders = rows);
  }

  Future<void> _loadStagingSpans() async {
    try {
      final spans = await widget.api.fetchStagingSpans();
      if (mounted) setState(() => _stagingSpans = spans);
    } catch (_) {}
  }

  Future<void> _handleRecapturePrefill() async {
    final pre = _pendingPrefill;
    if (pre == null) return;
    _pendingPrefill = null;
    widget.onRecaptureConsumed?.call();
    if (pre.latitude != null && pre.longitude != null) {
      _mapController.move(LatLng(pre.latitude!, pre.longitude!), 17);
      await _openCaptureForm(
        LatLng(pre.latitude!, pre.longitude!),
        prefill: pre,
      );
    }
  }

  /// Load the current technician's assigned hexagons (work territory overlay).
  Future<void> _loadAssignments({bool force = false}) async {
    if (_assignmentsLoading && !force) return;
    final generation = ++_assignmentLoadGeneration;
    _assignmentsLoading = true;
    if (mounted) setState(() {});
    try {
      final assignments = await widget.api.fetchMyAssignments();
      if (!mounted || generation != _assignmentLoadGeneration) return;
      final hadAssignments = _assignments.isNotEmpty;
      setState(() => _assignments = assignments);
      if (!hadAssignments &&
          assignments.isNotEmpty &&
          !_hasFittedToAssignments) {
        _hasFittedToAssignments = true;
        _fitToAssignments();
      }
      if (assignments.isNotEmpty) {
        final points = assignments.expand((h) => h.ring).toList();
        unawaited(_tileCacheService.prefetchForBounds(points));
      }
    } catch (e) {
      // #region agent log
      agentLog(
        location: 'map_screen.dart:_loadAssignments',
        message: 'assignments fetch failed',
        hypothesisId: 'H-assign',
        runId: 'assign-1',
        data: {
          'error': e.toString(),
          'technicianId': widget.api.config.technicianId,
        },
      );
      // #endregion
    } finally {
      if (mounted && generation == _assignmentLoadGeneration) {
        setState(() => _assignmentsLoading = false);
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_loadAssignments(force: true));
      if (_position != null) {
        unawaited(_fieldLocationService.reportNow(_position!));
      }
    }
  }

  /// Status-based color for an assigned hexagon outline/fill.
  Color _assignmentFill(HexAssignment hex) {
    if (hex.isDone) return const Color(0xFF16A34A); // green
    if (hex.isBlocked) return const Color(0xFFDC2626); // red
    if (hex.isInProgress) return const Color(0xFF2563EB); // blue
    return const Color(0xFFF59E0B); // amber — ASSIGNED
  }

  /// Fit the map camera to cover all assigned hexagons (work-scope overview).
  void _fitToAssignments() {
    final points = <LatLng>[
      for (final hex in _assignments) ...hex.ring,
    ];
    if (points.isEmpty) return;
    _exitFollowMode();
    _programmaticCamera = true;
    try {
      _mapController.fitCamera(
        CameraFit.coordinates(
          coordinates: points,
          padding: const EdgeInsets.all(48),
          maxZoom: 16,
        ),
      );
    } finally {
      _programmaticCamera = false;
    }
  }

  @override
  void didUpdateWidget(MapScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.recapturePrefill != null &&
        widget.recapturePrefill != oldWidget.recapturePrefill) {
      _pendingPrefill = widget.recapturePrefill;
      unawaited(_handleRecapturePrefill());
    }
    if (oldWidget.api.config.martinBaseUrl != widget.api.config.martinBaseUrl ||
        oldWidget.api.config.syncBaseUrl != widget.api.config.syncBaseUrl ||
        oldWidget.api.config.technicianId != widget.api.config.technicianId) {
      ConnectivityService.instance.configureSyncProbe(widget.api.config.syncBaseUrl);
      _fieldLocationService = FieldLocationService(widget.api);
      _martinGridLatched = false;
      _probeMartinGrid();
      _loadNodes(anchor: _defaultCenter);
      _hasFittedToAssignments = false;
      _loadAssignments(force: true);
    }
    if (oldWidget.refreshTrigger != widget.refreshTrigger) {
      _syncPending();
      _loadAssignments(force: true);
      unawaited(_loadStagingSpans());
      final anchor = _nodesFetchAnchor();
      if (_h3Streaming && anchor != null) {
        unawaited(
          _refreshH3Delta(
            FieldMapDeltaRequest(
              latitude: anchor.latitude,
              longitude: anchor.longitude,
              ringK: _h3RingK,
            ),
          ),
        );
      } else {
        _loadNodes();
      }
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _assignmentsPollTimer?.cancel();
    _cameraTicker?.dispose();
    _gpsFallbackTimer?.cancel();
    _headingFusion.dispose();
    _positionSub?.cancel();
    _compassSub?.cancel();
    _mapEventSub?.cancel();
    _mapDeltaSub?.cancel();
    _flySub?.cancel();
    _connectivitySub?.cancel();
    _linkSub?.cancel();
    _cancelToolCameraAnim();
    _mapController.dispose();
    super.dispose();
  }

  List<AssetNode> get _allVisibleNodes => _nodes
      .where((n) => n.hasCoordinates && _layerVisibility.isVisible(n.layer))
      .toList();

  bool get _showMartinGrid =>
      (_martinGridLatched || _martinReachable) && _layerVisibility.onGrid;

  /// Staging / field overlays; master grid dots stay visible for tap targets.
  List<AssetNode> get _markerNodes => _allVisibleNodes;

  /// Pan to loaded grid when the viewport is empty (common off-site / bad GPS).
  void _ensureMapShowsGrid() {
    if (_allVisibleNodes.isEmpty) return;
    if (_hasFittedToGrid && _hasNodesNearMapCenter(radiusM: 25000)) return;
    _maybeFitMapToVisibleNodes();
  }

  void _maybeFitMapToVisibleNodes() {
    if (_allVisibleNodes.isEmpty) return;
    // When following GPS or we already know the user's location, keep the
    // camera on the user instead of yanking it to the grid bounds. Fitting is
    // only a fallback for the off-site / no-GPS case.
    if (_followMe || _hasValidPosition) return;
    if (_hasFittedToGrid && _hasNodesNearMapCenter(radiusM: 1200)) return;
    _fitMapToVisibleNodes();
    _hasFittedToGrid = true;
  }

  Future<void> _loadNodesFromCache() async {
    try {
      final cached = await OfflineDb.loadCachedMapNodes();
      if (!mounted || cached.isEmpty) return;
      setState(() {
        _nodes = cached;
        _usingCache = true;
      });
      agentLog(
        location: 'map_screen.dart:_loadNodesFromCache',
        message: 'cache bootstrap',
        hypothesisId: 'H-perf',
        runId: 'perf-1',
        data: {'nodeCount': cached.length},
      );
    } catch (_) {
      // ignore corrupt cache
    }
  }

  void _scheduleGpsFallbackLoad() {
    _gpsFallbackTimer?.cancel();
    _gpsFallbackTimer = Timer(const Duration(seconds: 10), () {
      if (!mounted || _hasValidPosition || _nodes.isNotEmpty) return;
      agentLog(
        location: 'map_screen.dart:_scheduleGpsFallbackLoad',
        message: 'gps timeout fallback load',
        hypothesisId: 'H-perf',
        runId: 'perf-1',
      );
      _loadNodes(anchor: _defaultCenter);
    });
  }

  bool _shouldFetchNodesForZoom([double? zoom]) {
    return _safeZoom(zoom) >= _nodeFetchMinZoom;
  }

  Future<void> _probeMartinGrid() async {
    final ok = await probeMartinReachable(widget.api.config.martinBaseUrl);
    if (ok) _martinGridLatched = true;
    if (!mounted) return;
    setState(() => _martinReachable = _martinGridLatched);
    // #region agent log
    agentLog(
      location: 'map_screen.dart:_probeMartinGrid',
      message: 'martin grid state',
      hypothesisId: 'H4',
      ingestHost: hostFromUrl(widget.api.config.martinBaseUrl),
      data: {
        'martinReachable': _martinGridLatched,
        'martinProbeOk': ok,
        'martinBaseUrl': widget.api.config.martinBaseUrl,
        'syncBaseUrl': widget.api.config.syncBaseUrl,
        'showMartinGrid': ok && _layerVisibility.onGrid,
        'mapZoom': _safeZoom(),
        'nodeCount': _nodes.length,
        'onGridLayer': _layerVisibility.onGrid,
      },
    );
    // #endregion
  }

  Future<void> _refreshPendingCount() async {
    final items = await OfflineDb.listSyncQueueItems();
    if (mounted) {
      setState(() => _pendingCount = items.where((i) => i.isPending).length);
    }
  }

  Future<void> _syncPending() async {
    setState(() => _syncing = true);
    await _captureService.syncAllPending();
    await _loadWorkOrders();
    await _refreshPendingCount();
    if (mounted) setState(() => _syncing = false);
  }

  /// Rebuild [_nodes] from per-cell cache plus any queued local captures.
  Future<void> _rebuildNodesFromCellCache() async {
    final merged = _cellNodeCache.values.expand((e) => e).toList();
    final seen = merged.map((n) => n.mrid).toSet();
    try {
      final pending = await OfflineDb.pendingCaptures();
      for (final row in pending) {
        final mrid = row['mrid'] as String?;
        if (mrid != null && seen.contains(mrid)) continue;
        final localId = row['id'] as int;
        final displayMrid = mrid ?? 'local:$localId';
        merged.add(
          AssetNode(
            mrid: displayMrid,
            name: row['name'] as String,
            validation: 'PENDING_FIELD',
            latitude: (row['latitude'] as num).toDouble(),
            longitude: (row['longitude'] as num).toDouble(),
            tier: 'staging',
            layer: MapNodeLayer.queuedLocal,
            assetKind: assetKindFromString(row['asset_kind'] as String?),
            boundaryFeederId: row['boundary_feeder_id'] as String?,
            operatingUtility: row['operating_utility'] as String?,
            substationName: row['substation_name'] as String?,
          ),
        );
        seen.add(displayMrid);
      }
    } catch (_) {
      // ignore corrupt local queue
    }
    _nodes = merged;
  }

  /// Partial map refresh: re-fetch only the H3 cell(s) around a change, merge into cache.
  Future<void> _refreshH3Delta(FieldMapDeltaRequest request) async {
    if (!request.hasTarget) return;
    if (request.refreshAssignments) {
      unawaited(_loadAssignments());
    }

    final generation = ++_nodesLoadGeneration;
    final result = await widget.api.fetchMapCellDelta(
      latitude: request.latitude,
      longitude: request.longitude,
      h3Index: request.h3Index,
      k: request.ringK,
      res: _h3Res,
    );
    if (!mounted || generation != _nodesLoadGeneration) return;
    if (result.error != null || result.cells.isEmpty) return;

    final byCell = <String, List<AssetNode>>{};
    for (final node in result.nodes) {
      final cell = node.h3;
      if (cell == null) continue;
      (byCell[cell] ??= <AssetNode>[]).add(node);
    }

    for (final cell in result.cells) {
      _cellNodeCache[cell] = byCell[cell] ?? const <AssetNode>[];
      _loadedCells.add(cell);
    }

    await _rebuildNodesFromCellCache();
    if (!mounted || generation != _nodesLoadGeneration) return;

    setState(() {
      _usingCache = false;
      _loadIssue = _nodes.isEmpty ? _loadIssue : null;
      _loading = false;
    });

    agentLog(
      location: 'map_screen.dart:_refreshH3Delta',
      message: 'h3 delta merged',
      hypothesisId: 'H-delta',
      runId: 'delta-1',
      ingestHost: hostFromUrl(widget.api.config.syncBaseUrl),
      data: {
        'nodeCount': _nodes.length,
        'cells': result.cells.length,
        'lat': request.latitude,
        'lng': request.longitude,
        'h3': request.h3Index,
      },
    );
  }

  void _applyGpsPosition(Position pos) {
    if (!mounted || !isFiniteLatLng(pos.latitude, pos.longitude)) return;
    _gpsFixAt = DateTime.now();
    _gpsFallbackTimer?.cancel();
    setState(() => _position = pos);
    _displayLocation.snapTo(pos.latitude, pos.longitude);
    _displayLocation.setGpsTarget(
      LatLng(pos.latitude, pos.longitude),
      speedMps: pos.speed,
      courseDeg: pos.heading,
    );
    _headingFusion.penalizeForPoorAccuracy(pos.accuracy);
    if (_followMe) {
      unawaited(_activateFollowMe());
    }
  }

  Future<void> _startGps() async {
    try {
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        agentLog(
          location: 'map_screen.dart:_startGps',
          message: 'location permission denied',
          hypothesisId: 'H-field',
          runId: 'field-1',
          data: {'permission': permission.toString()},
        );
        return;
      }

      final lastKnown = await Geolocator.getLastKnownPosition();
      if (lastKnown != null &&
          isFiniteLatLng(lastKnown.latitude, lastKnown.longitude)) {
        _applyGpsPosition(lastKnown);
      }

      final current = await Geolocator.getCurrentPosition(
        locationSettings: navigationLocationSettings(),
      );
      if (!mounted) return;
      if (!isFiniteLatLng(current.latitude, current.longitude)) return;
      _applyGpsPosition(current);
      agentLog(
        location: 'map_screen.dart:_startGps',
        message: 'gps first fix',
        hypothesisId: 'H-perf',
        runId: 'perf-1',
        data: {
          'lat': current.latitude,
          'lon': current.longitude,
          'accuracyM': current.accuracy,
        },
      );
      unawaited(_fieldLocationService.reportNow(current));
      _reloadNodesAtUser(LatLng(current.latitude, current.longitude));

      _positionSub = Geolocator.getPositionStream(
        locationSettings: navigationLocationSettings(),
      ).listen((pos) {
        if (!mounted) return;
        if (!isFiniteLatLng(pos.latitude, pos.longitude)) return;
        _headingFusion.updateGpsCourse(
          courseDeg: pos.heading,
          speedMps: pos.speed,
          accuracyMeters: pos.accuracy,
        );
        _headingFusion.penalizeForPoorAccuracy(pos.accuracy);
        _displayLocation.setGpsTarget(
          LatLng(pos.latitude, pos.longitude),
          speedMps: pos.speed,
          courseDeg: _headingFusion.heading ?? pos.heading,
        );
        _position = pos;
        if (!_navigationMode) {
          setState(() {
            _heading = _headingFusion.heading;
            _headingConfidence = _headingFusion.confidence;
          });
        }
        _maybeReloadNodesNear(pos);
        void reportLocation() => _fieldLocationService.maybeReport(pos);
        reportLocation();
        // Camera smoothing handled by 60fps display timer.
      });
    } catch (e) {
      agentLog(
        location: 'map_screen.dart:_startGps',
        message: 'gps start failed',
        hypothesisId: 'H-field',
        runId: 'field-1',
        data: {'error': e.toString()},
      );
    }
  }

  void _startCompass() {
    _compassSub = FlutterCompass.events?.listen((event) {
      final raw = event.heading;
      if (!mounted || raw == null || !raw.isFinite) return;
      final speed = _position?.speed ?? 0;
      if (!_navigationMode && speed >= 2.5) return;

      if (_navigationMode) {
        _headingFusion.updateNavigationBearing(raw);
      } else {
        _headingFusion.updateCompass(raw);
        setState(() {
          _heading = _headingFusion.heading;
          _headingConfidence = _headingFusion.confidence;
        });
      }
    });
  }

  void _applyFollowCamera({
    double? zoom,
    LatLng? center,
  }) {
    if (!_hasValidPosition || !_followMe || _tool != MapTool.pan) return;
    if (_userGesturing || _navigationMode) return;

    final mapCenter = center ??
        _displayLocation.point ??
        LatLng(_position!.latitude, _position!.longitude);
    if (!isValidLatLng(mapCenter)) return;

    final current = _mapController.camera.center;
    final movedM = isValidLatLng(current)
        ? _distance.as(LengthUnit.Meter, current, mapCenter)
        : double.infinity;
    if (movedM < _followPanThresholdM) return;

    _programmaticCamera = true;
    try {
      _mapController.move(mapCenter, _safeZoom(zoom));
    } finally {
      _programmaticCamera = false;
    }
  }

  void _syncMapRotation() {
    if (_navigationMode) return;
    final r = _mapController.camera.rotation;
    if (!r.isFinite) {
      _programmaticCamera = true;
      try {
        _mapController.rotate(0);
        _mapRotationDeg = 0;
      } finally {
        _programmaticCamera = false;
      }
      return;
    }
    if ((r - _mapRotationDeg).abs() > 0.05) {
      setState(() => _mapRotationDeg = r);
    }
  }

  void _onMapUserEvent(MapEvent event) {
    if (!_programmaticCamera) {
      if (event.source != MapEventSource.mapController &&
          event.source != MapEventSource.nonRotatedSizeChange &&
          event.source != MapEventSource.fitCamera) {
        final userMovedMap = event is MapEventMoveStart ||
            event is MapEventRotateStart ||
            event is MapEventScrollWheelZoom ||
            event is MapEventDoubleTapZoomStart ||
            event is MapEventFlingAnimationStart ||
            event.source == MapEventSource.dragStart ||
            event.source == MapEventSource.onDrag ||
            event.source == MapEventSource.multiFingerGestureStart ||
            event.source == MapEventSource.onMultiFinger ||
            event.source == MapEventSource.scrollWheel ||
            event.source == MapEventSource.doubleTapZoomAnimationController;

        if (userMovedMap) {
          _userGesturing = true;
          final isRotate = event is MapEventRotateStart ||
              event.source == MapEventSource.onMultiFinger ||
              event.source == MapEventSource.multiFingerGestureStart;
          _exitFollowMode(keepRotation: isRotate);
        }
      }
    }

    if (event is MapEventMoveEnd ||
        event is MapEventFlingAnimationEnd ||
        event is MapEventRotateEnd ||
        event.source == MapEventSource.dragEnd ||
        event.source == MapEventSource.multiFingerEnd) {
      if (_activeMapPointers == 0) {
        _userGesturing = false;
      }
      Future<void>.delayed(const Duration(milliseconds: 150), () {
        if (!mounted || _activeMapPointers > 0) return;
        _userGesturing = false;
      });
    }

    if (event is MapEventRotate ||
        event is MapEventRotateEnd ||
        event is MapEventMove ||
        event is MapEventMoveEnd ||
        event is MapEventFlingAnimation ||
        event is MapEventScrollWheelZoom) {
      if (!_navigationMode && !_programmaticCamera) {
        _recoverMapCameraIfNeeded();
      }
      if (!_navigationMode) {
        _syncMapRotation();
      }
    }

    if (event is MapEventMoveEnd || event is MapEventFlingAnimationEnd) {
      final center = _mapController.camera.center;
      if (isValidLatLng(center)) {
        // #region agent log
        if (_martinReachable && _showMartinGrid) {
          final zoom = _mapController.camera.zoom;
          final key = 'vp:${zoom.round()}:${center.latitude.toStringAsFixed(3)}';
          if (_loggedViewports.add(key) && _viewportLogCount < 15) {
            _viewportLogCount++;
            agentLog(
              location: 'map_screen.dart:_onMapUserEvent',
              message: 'viewport after pan/zoom',
              hypothesisId: 'H6',
              runId: 'post-fix-3',
              ingestHost: hostFromUrl(widget.api.config.martinBaseUrl),
              data: {
                'zoom': zoom,
                'centerLat': center.latitude,
                'centerLon': center.longitude,
                'showMartinGrid': _showMartinGrid,
                'maxVectorZoom': 16,
              },
            );
          }
        }
        // #endregion
        unawaited(
          _tileCacheService.prefetchViewport(
            latitude: center.latitude,
            longitude: center.longitude,
            zoom: _mapController.camera.zoom,
          ),
        );
        _maybeReloadNodesForViewport(center);
      }
    }
  }

  void _maybeReloadNodesForViewport(LatLng center) {
    if (!_shouldFetchNodesForZoom()) return;
    final anchor = _lastNodesFetchAnchor;
    if (anchor == null) {
      _reloadNodes(center);
      return;
    }
    final movedM = _distance.as(LengthUnit.Meter, anchor, center);
    // Smaller step when streaming so the k-ring stays centered on the user.
    final threshold = _h3Streaming ? 150.0 : _nodesRefetchMeters;
    if (movedM >= threshold) {
      _reloadNodes(center);
    }
  }

  /// Stop map follow/rotation; keep map position, show heading wedge only.
  void _exitFollowMode({bool keepRotation = false}) {
    if (!_followMe && !_headingUp) return;
    _headingFusion.setNavigationMode(false);
    _navigationCamera.reset();
    setState(() {
      _followMe = false;
      _headingUp = false;
    });
    if (keepRotation) return;
    _programmaticCamera = true;
    try {
      _mapController.rotate(0);
      _mapRotationDeg = 0;
    } finally {
      _programmaticCamera = false;
    }
  }

  void _resetMapNorth() {
    _headingFusion.setNavigationMode(false);
    _navigationCamera.reset();
    setState(() => _headingUp = false);
    _programmaticCamera = true;
    try {
      _mapController.rotate(0);
      _mapRotationDeg = 0;
    } finally {
      _programmaticCamera = false;
    }
  }

  LatLng? _nodesFetchAnchor({LatLng? anchor}) {
    if (anchor != null && isValidLatLng(anchor)) return anchor;
    if (_hasValidPosition) {
      return LatLng(_position!.latitude, _position!.longitude);
    }
    final center = _mapController.camera.center;
    if (isValidLatLng(center)) return center;
    return null;
  }

  bool _hasNodesNearMapCenter({double radiusM = 30000}) {
    final center = _mapController.camera.center;
    if (!isValidLatLng(center) || _allVisibleNodes.isEmpty) return false;
    for (final node in _allVisibleNodes) {
      final m = _distance.as(
        LengthUnit.Meter,
        center,
        LatLng(node.latitude!, node.longitude!),
      );
      if (m <= radiusM) return true;
    }
    return false;
  }

  void _fitMapToVisibleNodes() {
    final nodes = _allVisibleNodes;
    if (nodes.isEmpty) return;
    if (_hasNodesNearMapCenter(radiusM: 1200)) return;

    var minLat = nodes.first.latitude!;
    var maxLat = minLat;
    var minLon = nodes.first.longitude!;
    var maxLon = minLon;
    for (final node in nodes) {
      minLat = math.min(minLat, node.latitude!);
      maxLat = math.max(maxLat, node.latitude!);
      minLon = math.min(minLon, node.longitude!);
      maxLon = math.max(maxLon, node.longitude!);
    }
    final bounds = LatLngBounds(
      LatLng(minLat, minLon),
      LatLng(maxLat, maxLon),
    );
    _programmaticCamera = true;
    try {
      _mapController.fitCamera(
        CameraFit.bounds(
          bounds: bounds,
          padding: const EdgeInsets.all(56),
        ),
      );
    } finally {
      _programmaticCamera = false;
    }
    if (_followMe) {
      setState(() => _followMe = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Centered map on grid assets near your search area.',
          ),
          duration: Duration(seconds: 3),
        ),
      );
    }
  }

  void _maybeReloadNodesNear(Position pos) {
    if (!_shouldFetchNodesForZoom()) return;
    final here = LatLng(pos.latitude, pos.longitude);
    if (!isValidLatLng(here)) return;
    final anchor = _lastNodesFetchAnchor;
    if (anchor == null) {
      _reloadNodes(here);
      return;
    }
    final movedM = _distance.as(LengthUnit.Meter, anchor, here);
    final threshold = _h3Streaming ? 150.0 : _nodesRefetchMeters;
    if (movedM >= threshold) {
      _reloadNodes(here);
    }
  }

  /// Force a node fetch anchored at the user's location, even if a bootstrap
  /// load is still in flight (load coalescing would otherwise drop it).
  void _reloadNodesAtUser(LatLng here) {
    if (!isValidLatLng(here)) return;
    if (!_shouldFetchNodesForZoom()) return;
    // Cancel any in-flight bootstrap so the user-location load starts immediately.
    ++_nodesLoadGeneration;
    _nodesLoadFuture = null;
    _reloadNodes(here);
  }

  /// Reload nodes for [center] using H3 streaming when enabled, else legacy KNN.
  void _reloadNodes(LatLng center) {
    if (_h3Streaming) {
      unawaited(_streamNodesForViewport(center));
    } else {
      _loadNodes(anchor: center);
    }
  }

  /// Incremental H3 streaming: fetch only the newly entered cells, merge into the
  /// per-cell cache, evict cells outside the current k-ring, then repaint.
  Future<void> _streamNodesForViewport(LatLng center) async {
    final generation = ++_nodesLoadGeneration;
    final sw = Stopwatch()..start();
    final result = await widget.api.fetchMapNodesByCells(
      latitude: center.latitude,
      longitude: center.longitude,
      k: _h3RingK,
      res: _h3Res,
      have: _loadedCells,
    );
    if (!mounted || generation != _nodesLoadGeneration) return;

    if (result.error != null || result.cells.isEmpty) {
      agentLog(
        location: 'map_screen.dart:_streamNodesForViewport',
        message: 'h3 fallback to knn',
        hypothesisId: 'H-perf',
        runId: 'perf-1',
        data: {
          'ms': sw.elapsedMilliseconds,
          'error': result.error?.toString(),
        },
      );
      _loadNodes(anchor: center);
      return;
    }

    final ring = result.cells.toSet();
    final byCell = <String, List<AssetNode>>{};
    for (final node in result.nodes) {
      final cell = node.h3;
      if (cell == null) continue;
      (byCell[cell] ??= <AssetNode>[]).add(node);
    }

    for (final cell in result.fetchedCells) {
      _cellNodeCache[cell] = byCell[cell] ?? const <AssetNode>[];
    }
    _cellNodeCache.removeWhere((cell, _) => !ring.contains(cell));
    _loadedCells = ring;
    await _rebuildNodesFromCellCache();
    if (!mounted || generation != _nodesLoadGeneration) return;

    setState(() {
      _usingCache = false;
      _loading = false;
      _loadIssue = _nodes.isEmpty ? _loadIssue : null;
      _lastNodesFetchAnchor = center;
    });
    agentLog(
      location: 'map_screen.dart:_streamNodesForViewport',
      message: 'h3 cells merged',
      hypothesisId: 'H-perf',
      runId: 'perf-1',
      ingestHost: hostFromUrl(widget.api.config.syncBaseUrl),
      data: {
        'ms': sw.elapsedMilliseconds,
        'nodeCount': _nodes.length,
        'fetchedCells': result.fetchedCells.length,
        'ringCells': result.cells.length,
      },
    );
    _ensureMapShowsGrid();
  }

  Future<void> _loadNodes({LatLng? anchor}) {
    return _nodesLoadFuture ??= _loadNodesBody(anchor: anchor).whenComplete(() {
      _nodesLoadFuture = null;
    });
  }

  Future<void> _loadNodesBody({LatLng? anchor}) async {
    final fetchAt = _nodesFetchAnchor(anchor: anchor);
    final generation = ++_nodesLoadGeneration;
    setState(() {
      _loading = true;
      _error = null;
      if (_nodes.isEmpty) {
        _loadIssue = null;
        _usingCache = false;
      }
    });
    try {
      final loadSw = Stopwatch()..start();
      var result = await widget.api.fetchMapNodesFast(
        latitude: fetchAt?.latitude,
        longitude: fetchAt?.longitude,
      );
      if (!mounted || generation != _nodesLoadGeneration) return;

      if (result.nodes.isEmpty && fetchAt != null) {
        final atGhana = (fetchAt.latitude - GiopApi.defaultMapLat).abs() < 0.01 &&
            (fetchAt.longitude - GiopApi.defaultMapLon).abs() < 0.01;
        if (!atGhana) {
          result = await widget.api.fetchMapNodesFast(
            latitude: GiopApi.defaultMapLat,
            longitude: GiopApi.defaultMapLon,
          );
        }
      }
      if (!mounted || generation != _nodesLoadGeneration) return;

      agentLog(
        location: 'map_screen.dart:_loadNodes',
        message: 'nodes loaded',
        hypothesisId: 'H-perf',
        runId: 'perf-1',
        ingestHost: hostFromUrl(widget.api.config.syncBaseUrl),
        data: {
          'nodeCount': result.nodes.length,
          'issue': result.issue,
          'fromCache': result.fromCache,
          'generation': generation,
          'masterMs': result.masterMs,
          'totalMs': result.totalMs,
          'loadMs': loadSw.elapsedMilliseconds,
          'gpsFixAgeMs': _gpsFixAt == null
              ? null
              : DateTime.now().difference(_gpsFixAt!).inMilliseconds,
          'zoom': _mapController.camera.zoom,
        },
      );

      setState(() {
        if (result.nodes.isNotEmpty || _nodes.isEmpty) {
          _nodes = result.nodes;
        }
        _usingCache = result.fromCache;
        _loadIssue = result.nodes.isNotEmpty ? null : result.issue;
        _loading = false;
        if (fetchAt != null) _lastNodesFetchAnchor = fetchAt;
      });
      _maybeFitMapToVisibleNodes();
      _ensureMapShowsGrid();
      if (result.issue != null && mounted && result.nodes.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(result.issue!), duration: const Duration(seconds: 6)),
        );
      } else if (result.nodes.isEmpty && _nodes.isEmpty && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'No map nodes loaded. Open Settings → Test connections, then fix URLs.',
            ),
            duration: Duration(seconds: 6),
          ),
        );
      }
    } catch (e) {
      if (!mounted || generation != _nodesLoadGeneration) return;
      final message = e.toString();
      setState(() {
        if (_nodes.isEmpty) {
          _error = message.length > 280 ? '${message.substring(0, 280)}…' : message;
          _loadIssue = _error;
        }
        _loading = false;
      });
    }
  }

  void _animateCameraTo({
    required LatLng center,
    required double zoom,
    double rotationDeg = 0,
    Duration duration = _addModeFlyDuration,
  }) {
    _toolCameraAnim?.stop();
    _toolCameraAnim?.dispose();

    final camera = _mapController.camera;
    final targetZoom = _safeZoom(zoom);
    final startRot = camera.rotation;
    if (!isValidLatLng(center)) return;

    final distM = isValidLatLng(camera.center)
        ? _distance.as(LengthUnit.Meter, camera.center, center)
        : double.infinity;
    final zoomDelta = (targetZoom - camera.zoom).abs();
    final rotDelta = (startRot - rotationDeg).abs();
    if (distM < 8 && zoomDelta < 0.15 && rotDelta < 0.5) {
      _programmaticCamera = true;
      try {
        _mapController.moveAndRotate(center, targetZoom, rotationDeg);
        _mapRotationDeg = rotationDeg;
      } finally {
        _programmaticCamera = false;
      }
      return;
    }

    final controller = AnimationController(duration: duration, vsync: this);
    _toolCameraAnim = controller;
    final animation = CurvedAnimation(parent: controller, curve: Curves.easeInOutCubic);

    final latTween = Tween<double>(
      begin: camera.center.latitude,
      end: center.latitude,
    );
    final lngTween = Tween<double>(
      begin: camera.center.longitude,
      end: center.longitude,
    );
    final zoomTween = Tween<double>(begin: camera.zoom, end: targetZoom);
    final rotTween = Tween<double>(begin: startRot, end: rotationDeg);

    _programmaticCamera = true;
    controller.addListener(() {
      if (!mounted) return;
      _mapController.moveAndRotate(
        LatLng(latTween.evaluate(animation), lngTween.evaluate(animation)),
        zoomTween.evaluate(animation),
        rotTween.evaluate(animation),
      );
      _mapRotationDeg = rotTween.evaluate(animation);
    });
    controller.addStatusListener((status) {
      if (status == AnimationStatus.completed ||
          status == AnimationStatus.dismissed) {
        _programmaticCamera = false;
        controller.dispose();
        if (_toolCameraAnim == controller) _toolCameraAnim = null;
      }
    });
    _toolCameraAnim = controller;
    controller.forward();
  }

  void _setTool(MapTool tool) {
    setState(() {
      _tool = tool;
      if (tool != MapTool.drawSpan) _spanSourceMrid = null;
      if (tool != MapTool.measure) _measurePoints = const [];
      if (tool == MapTool.addPoint) {
        _followMe = false;
        _headingUp = false;
        _headingFusion.setNavigationMode(false);
      }
    });
    if (tool == MapTool.addPoint) {
      if (_hasValidPosition) {
        final target = _displayLocation.point ??
            LatLng(_position!.latitude, _position!.longitude);
        _animateCameraTo(
          center: target,
          zoom: _addModeZoom,
          rotationDeg: 0,
        );
      } else {
        _animateCameraTo(
          center: _mapController.camera.center,
          zoom: _safeZoom(_addModeZoom),
          rotationDeg: 0,
        );
      }
    } else {
      _cancelToolCameraAnim();
    }
  }

  void _centerOnMe() {
    if (!_hasValidPosition) return;
    if (_navigationMode) {
      setState(() {
        _followMe = false;
        _headingUp = false;
      });
      _headingFusion.setNavigationMode(false);
      _resetMapNorth();
      return;
    }
    unawaited(_activateFollowMe());
  }

  Future<void> _activateFollowMe() async {
    if (!mounted || !_hasValidPosition) return;
    setState(() {
      _followMe = true;
      _headingUp = true;
      _userGesturing = false;
    });
    _headingFusion.setNavigationMode(true);
    final bearing = _headingFusion.heading;
    if (bearing != null) {
      _navigationCamera.setBearingTarget(bearing);
      _navigationCamera.snapToTarget();
    }
    _applyNavigationCameraFrame(zoom: 17, snap: true);
  }

  LatLng get _mapCenter {
    final center = _mapController.camera.center;
    if (isValidLatLng(center)) return center;
    return latLngIfValid(_position?.latitude, _position?.longitude) ??
        _defaultCenter;
  }

  Future<(LatLng point, String? snappedName)> _resolvePlacement(LatLng raw) async {
    try {
      final snap = await widget.api
          .fetchSnapPoint(
            latitude: raw.latitude,
            longitude: raw.longitude,
            snapM: _snapMeters,
          )
          .timeout(const Duration(milliseconds: 1500));
      if (snap.snapped) {
        return (
          LatLng(snap.latitude, snap.longitude),
          snap.snappedToName,
        );
      }
    } catch (_) {
      // offline or slow — local snap
    }
    final (placed, snappedName) = _placementPoint(raw);
    return (placed, snappedName);
  }

  (LatLng point, String? snappedName) _placementPoint(LatLng raw) {
    AssetNode? nearest;
    var nearestM = _snapMeters;
    for (final node in _nodes) {
      if (!node.hasCoordinates) continue;
      final nodePoint = LatLng(node.latitude!, node.longitude!);
      final m = _distance.as(LengthUnit.Meter, raw, nodePoint);
      if (m < nearestM) {
        nearestM = m;
        nearest = node;
      }
    }
    if (nearest != null) {
      return (
        LatLng(nearest.latitude!, nearest.longitude!),
        nearest.name,
      );
    }
    return (raw, null);
  }

  AssetNode? _nodeNear(LatLng point) {
    AssetNode? hit;
    var minM = _identifyMeters;
    for (final node in _allVisibleNodes) {
      final m = _distance.as(
        LengthUnit.Meter,
        point,
        LatLng(node.latitude!, node.longitude!),
      );
      if (m < minM) {
        minM = m;
        hit = node;
      }
    }
    return hit;
  }

  void _onMapTap(TapPosition tap, LatLng point) {
    if (!isValidLatLng(point)) return;
    if (_tool == MapTool.measure) {
      setState(() => _measurePoints = [..._measurePoints, point]);
      return;
    }
    if (_tool == MapTool.addPoint) {
      _openCaptureForm(point);
      return;
    }
    if (_tool == MapTool.drawSpan) {
      final node = _nodeNear(point);
      if (node == null) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Tap a pole or node to connect')),
        );
        return;
      }
      if (_spanSourceMrid == null) {
        setState(() {
          _spanSourceMrid = node.mrid;
          _selectedNodeMrid = node.mrid;
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('From ${node.name} — tap the next node')),
        );
        return;
      }
      if (_spanSourceMrid == node.mrid) return;
      unawaited(_submitSpan(_spanSourceMrid!, node.mrid));
      return;
    }
    final node = _nodeNear(point);
    if (node != null) {
      _openNodeDetail(node);
      return;
    }
    setState(() {
      _selectedNodeMrid = null;
      _highlightLines = const [];
    });
  }

  Map<String, LatLng> get _neighborPositionIndex {
    return {
      for (final node in _nodes)
        if (node.hasCoordinates) node.mrid: LatLng(node.latitude!, node.longitude!),
    };
  }

  Future<void> _openNodeDetail(AssetNode node) async {
    if (!node.hasCoordinates) return;

    final origin = LatLng(node.latitude!, node.longitude!);
    setState(() {
      _selectedNodeMrid = node.mrid;
      _highlightLines = const [];
    });

    final isLocal = node.isLocalQueued;
    final localCapture = isLocal
        ? await OfflineDb.getPendingCaptureByMrid(node.mrid)
        : null;

    final cached = isLocal
        ? null
        : await OfflineDb.getCachedNodeTopology(node.mrid);
    if (!mounted) return;
    late final Future<Map<String, dynamic>?> topologyFuture;

    if (isLocal) {
      topologyFuture = Future.value(null);
    } else if (cached != null) {
      setState(
        () => _highlightLines = highlightLinesFromTopology(
          cached,
          origin: origin,
          neighborPositionsByMrid: _neighborPositionIndex,
        ),
      );
      topologyFuture = Future.value(cached);
    } else {
      topologyFuture = widget.api.fetchNodeConnections(node.mrid);
      unawaited(
        topologyFuture.then((topology) {
          if (!mounted || topology == null) return;
          setState(
            () => _highlightLines = highlightLinesFromTopology(
              topology,
              origin: origin,
              neighborPositionsByMrid: _neighborPositionIndex,
            ),
          );
        }).catchError((Object _) {
          // Network errors are shown in the sheet only for server-backed nodes.
        }),
      );
    }

    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) => _NodeDetailSheet(
        node: node,
        topologyFuture: topologyFuture,
        localCapture: localCapture,
        onNavigate: () {
          Navigator.pop(ctx);
          setState(() {
            _stakeoutTarget = origin;
            _stakeoutLabel = node.name;
            _followMe = true;
          });
        },
      ),
    );
  }

  Widget _assetMarker(AssetNode node) {
    final selected = _selectedNodeMrid == node.mrid;
    final onGrid = node.layer == MapNodeLayer.onGrid;
    final vectorActive = onGrid && _showMartinGrid;

    // Portal-style tiny dots for master grid (always visible for tap targets).
    if (onGrid) {
      final zoom = _safeZoom();
      final dot = selected
          ? 12.0
          : (vectorActive ? (zoom >= 16 ? 9.0 : 8.0) : 9.0);
      final fill = vectorActive
          ? GiopSldColors.nodeFill.withValues(alpha: 0.72)
          : GiopSldColors.nodeFill;
      return GestureDetector(
        onTap: () => _openNodeDetail(node),
        behavior: HitTestBehavior.opaque,
        child: Container(
          width: dot,
          height: dot,
          decoration: BoxDecoration(
            color: fill,
            shape: BoxShape.circle,
            border: Border.all(
              color: selected ? GiopSldColors.lv : Colors.white,
              width: selected ? 1.5 : 0.75,
            ),
          ),
        ),
      );
    }

    final kind = node.displayKind;
    final color = assetKindColor(kind);

    return GestureDetector(
      onTap: () => _openNodeDetail(node),
      behavior: HitTestBehavior.opaque,
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.center,
        children: [
          Container(
            width: selected ? 28 : 22,
            height: selected ? 28 : 22,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.94),
              shape: BoxShape.circle,
              border: Border.all(
                color: selected ? GiopSldColors.lv : color.withValues(alpha: 0.9),
                width: selected ? 2 : 1,
              ),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x44000000),
                  blurRadius: 3,
                  offset: Offset(0, 1),
                ),
              ],
            ),
            child: Icon(
              assetKindIcon(kind),
              color: color,
              size: selected ? 16 : 13,
            ),
          ),
          if (node.hasWireConnections)
            Positioned(
              right: -1,
              bottom: -1,
              child: Container(
                width: 11,
                height: 11,
                decoration: BoxDecoration(
                  color: Colors.blue.shade700,
                  shape: BoxShape.circle,
                  border: Border.all(color: Colors.white, width: 1.5),
                ),
                child: const Icon(Icons.link, size: 6, color: Colors.white),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _submitSpan(String sourceId, String targetId) async {
    final workOrderId = await CapturePreferences.activeWorkOrderId();
    await _captureService.submitSpan(
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      workOrderId: workOrderId,
    );
    if (!mounted) return;
    setState(() {
      _spanSourceMrid = null;
      _tool = MapTool.pan;
      _selectedNodeMrid = null;
    });
    await _loadStagingSpans();
    unawaited(_captureService.syncAllPending());
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Span saved')),
    );
  }

  Future<void> _openCaptureForm(
    LatLng rawPoint, {
    CapturePrefill? prefill,
  }) async {
    final (placed, snappedName) = await _resolvePlacement(rawPoint);
    final result = await showModalBottomSheet<CaptureResult>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => FieldCaptureSheet(
        api: widget.api,
        captureService: _captureService,
        latitude: placed.latitude,
        longitude: placed.longitude,
        snappedToName: snappedName,
        gpsAccuracyM: _position?.accuracy,
        assignments: _assignments,
        prefill: prefill,
      ),
    );
    if (result != null && mounted) {
      await _refreshPendingCount();
      if (!mounted) return;
      unawaited(_rebuildNodesFromCellCache());
      unawaited(_loadStagingSpans());
      unawaited(_captureService.syncAllPending());
      if (result.saved) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              result.synced
                  ? 'Saved — ${result.mrid}'
                  : 'Saved — ${result.mrid ?? 'pending sync'}',
            ),
            duration: const Duration(seconds: 2),
          ),
        );
      }
      setState(() => _tool = MapTool.pan);
    }
  }

  void _confirmCenterPlacement() {
    _openCaptureForm(_mapCenter);
  }

  void _placeAtGps() {
    final point = latLngIfValid(_position?.latitude, _position?.longitude);
    if (point == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('GPS not available yet')),
      );
      return;
    }
    _mapController.move(point, _safeZoom());
    _openCaptureForm(point);
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 100,
            child: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }

  void _showLayers() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setSheetState) => LayerPanelSheet(
          visibility: _layerVisibility,
          pendingCount: _pendingCount,
          syncing: _syncing,
          showWorkOrders: _showWorkOrders,
          onShowWorkOrdersChanged: (v) {
            setState(() => _showWorkOrders = v);
            FieldUserPreferences.setShowWorkOrdersOnMap(v);
            setSheetState(() {});
          },
          onOpenSyncQueue: () {
            Navigator.pop(ctx);
            Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => SyncQueueScreen(api: widget.api),
              ),
            );
          },
          onSync: () {
            Navigator.pop(ctx);
            _syncPending();
          },
          onChanged: () {
            setState(() {});
            setSheetState(() {});
          },
        ),
      ),
    );
  }

  double? get _measureTotalMeters {
    if (_measurePoints.length < 2) return null;
    var total = 0.0;
    for (var i = 1; i < _measurePoints.length; i++) {
      total += _distance.as(
        LengthUnit.Meter,
        _measurePoints[i - 1],
        _measurePoints[i],
      );
    }
    return total;
  }

  double? get _stakeoutDistanceM {
    if (_stakeoutTarget == null || !_hasValidPosition) return null;
    return _distance.as(
      LengthUnit.Meter,
      LatLng(_position!.latitude, _position!.longitude),
      _stakeoutTarget!,
    );
  }

  List<Marker> get _workOrderMarkers {
    if (!_showWorkOrders) return const [];
    final markers = <Marker>[];
    for (final wo in _workOrders) {
      final lat = (wo['latitude'] as num?)?.toDouble();
      final lon = (wo['longitude'] as num?)?.toDouble();
      if (lat == null || lon == null || !lat.isFinite || !lon.isFinite) continue;
      final ref = wo['reference'] as String? ?? wo['id'] as String? ?? 'WO';
      markers.add(
        Marker(
          point: LatLng(lat, lon),
          width: 34,
          height: 34,
          child: Tooltip(
            message: ref,
            child: Container(
              decoration: BoxDecoration(
                color: Colors.indigo.shade600,
                shape: BoxShape.circle,
                border: Border.all(color: Colors.white, width: 1.5),
              ),
              child: const Icon(Icons.assignment, color: Colors.white, size: 18),
            ),
          ),
        ),
      );
    }
    return markers;
  }

  @override
  Widget build(BuildContext context) {
    final initialCenter =
        latLngIfValid(_position?.latitude, _position?.longitude) ??
            _defaultCenter;
    final userPoint = _displayLocation.point ??
        latLngIfValid(_position?.latitude, _position?.longitude);

    return Scaffold(
      backgroundColor: GiopSldColors.mapBackground,
      body: Stack(
        children: [
          Listener(
            onPointerDown: _onMapPointerDown,
            onPointerUp: _onMapPointerUp,
            onPointerCancel: _onMapPointerUp,
            child: FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: initialCenter,
              initialZoom: 16,
              minZoom: _minZoom,
              maxZoom: _maxZoom,
              backgroundColor: GiopSldColors.mapBackground,
              onTap: _onMapTap,
            ),
            children: [
              TileLayer(
                urlTemplate:
                    'https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
                userAgentPackageName: 'com.giop.field',
                tileBuilder: (context, tileWidget, tile) => Opacity(
                  opacity: GiopSldColors.basemapTileOpacity,
                  child: tileWidget,
                ),
              ),
              if (_showAssignments && _assignments.isNotEmpty)
                PolygonLayer(
                  polygons: [
                    for (final hex in _assignments)
                      Polygon(
                        points: hex.ring,
                        color: _assignmentFill(hex).withValues(alpha: 0.18),
                        borderColor: _assignmentFill(hex),
                        borderStrokeWidth: 1.5,
                      ),
                  ],
                ),
              if (_showMartinGrid)
                GiopGridVectorLayer(
                  key: ValueKey(widget.api.config.martinBaseUrl),
                  martinBaseUrl: widget.api.config.martinBaseUrl,
                ),
              if (_highlightLines.isNotEmpty)
                PolylineLayer(
                  polylines: [
                    for (final line in _highlightLines)
                      Polyline(
                        points: line.points,
                        color: giopVoltageColor(line.voltage).withValues(
                          alpha: line.fallback ? 0.85 : 1.0,
                        ),
                        strokeWidth: highlightLineWidth(
                          line.voltage,
                          fallback: line.fallback,
                        ),
                        borderStrokeWidth: 2,
                        borderColor: Colors.white.withValues(alpha: 0.9),
                      ),
                  ],
                ),
              if (_stagingSpans.isNotEmpty)
                PolylineLayer(
                  polylines: [
                    for (final span in _stagingSpans)
                      if (span.points.length >= 2)
                        Polyline(
                          points: span.points,
                          color: Colors.orange.shade700.withValues(alpha: 0.9),
                          strokeWidth: 4,
                          borderStrokeWidth: 1.5,
                          borderColor: Colors.white,
                        ),
                  ],
                ),
              if (_measurePoints.length >= 2)
                PolylineLayer(
                  polylines: [
                    Polyline(
                      points: _measurePoints,
                      color: const Color(0xFF0EA5E9),
                      strokeWidth: 4,
                      borderStrokeWidth: 1.5,
                      borderColor: Colors.white,
                    ),
                  ],
                ),
              if (_stakeoutTarget != null && userPoint != null)
                PolylineLayer(
                  polylines: [
                    Polyline(
                      points: [userPoint, _stakeoutTarget!],
                      color: Colors.teal.withValues(alpha: 0.85),
                      strokeWidth: 3,
                      borderStrokeWidth: 1,
                      borderColor: Colors.white,
                    ),
                  ],
                ),
              MarkerLayer(
                key: ValueKey(
                  '${_layerVisibility.onGrid}'
                  '${_layerVisibility.ownStaging}'
                  '${_layerVisibility.otherStaging}'
                  '${_layerVisibility.queuedLocal}'
                  '$_selectedNodeMrid'
                  '$_showWorkOrders',
                ),
                markers: [
                  ..._workOrderMarkers,
                  for (final node in _markerNodes)
                    Marker(
                      point: LatLng(node.latitude!, node.longitude!),
                      width: node.layer == MapNodeLayer.onGrid
                          ? (_selectedNodeMrid == node.mrid ? 16 : 12)
                          : (_selectedNodeMrid == node.mrid ? 32 : 26),
                      height: node.layer == MapNodeLayer.onGrid
                          ? (_selectedNodeMrid == node.mrid ? 16 : 12)
                          : (_selectedNodeMrid == node.mrid ? 32 : 26),
                      child: _assetMarker(node),
                    ),
                  if (userPoint != null && !_navigationMode)
                    Marker(
                      point: userPoint,
                      width: 72,
                      height: 72,
                      alignment: Alignment.center,
                      child: UserLocationMarker(
                        heading: _heading,
                        headingConfidence: _headingConfidence,
                        accuracyMeters: _position!.accuracy,
                      ),
                    ),
                ],
              ),
            ],
          ),
          ),

          // Navigation puck: screen-fixed (Uber/Bolt); map rotates underneath.
          if (_navigationMode && _position != null)
            Positioned.fill(
              child: IgnorePointer(
                child: Center(
                  child: UserLocationMarker(
                    heading: _heading,
                    headingConfidence: _headingConfidence,
                    accuracyMeters: _position!.accuracy,
                    navigationMode: true,
                  ),
                ),
              ),
            ),

          if (_tool == MapTool.addPoint) const MapCrosshair(),

          // Top status bar
          Positioned(
            top: MediaQuery.of(context).padding.top + 8,
            left: 12,
            right: 12,
            child: _StatusBar(
              position: _position,
              heading: _heading,
              headingConfidence: _headingConfidence,
              headingUp: _headingUp,
              mapRotationDeg: _mapRotationDeg,
              nodeCount: _allVisibleNodes.length,
              vectorGrid: _showMartinGrid,
              usingCache: _usingCache,
              isOnline: _isOnline,
              linkUp: _linkUp,
              serverReachable: _serverReachable,
              tool: _tool,
              pendingCount: _pendingCount,
              onResetNorth: _resetMapNorth,
              onPendingTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => SyncQueueScreen(api: widget.api),
                ),
              ),
            ),
          ),

          Positioned(
            top: MediaQuery.of(context).padding.top + 52,
            left: 12,
            child: Row(
              children: [
                IconButton.filledTonal(
                  style: IconButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    backgroundColor: Colors.black.withValues(alpha: 0.55),
                    foregroundColor: Colors.white,
                  ),
                  tooltip: 'Search assets',
                  onPressed: () => FieldSearchSheet.show(context),
                  icon: const Icon(Icons.search, size: 20),
                ),
                const SizedBox(width: 6),
                IconButton.filledTonal(
                  style: IconButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    backgroundColor: Colors.black.withValues(alpha: 0.55),
                    foregroundColor: Colors.white,
                  ),
                  tooltip: 'Sync queue',
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => SyncQueueScreen(api: widget.api),
                    ),
                  ),
                  icon: Badge(
                    isLabelVisible: _pendingCount > 0,
                    label: Text('$_pendingCount'),
                    child: const Icon(Icons.cloud_upload_outlined, size: 20),
                  ),
                ),
              ],
            ),
          ),

          if (_showMartinGrid)
            Positioned(
              left: 12,
              bottom: 96,
              child: const GiopMapLegendChip(),
            ),

          Positioned(
            top: MediaQuery.of(context).padding.top + 56,
            right: 12,
            child: _AssignmentScopeChip(
              hexCount: _assignments.length,
              visible: _showAssignments,
              loading: _assignmentsLoading,
              technicianId: widget.api.config.technicianId,
              onToggle: () =>
                  setState(() => _showAssignments = !_showAssignments),
              onFit: _fitToAssignments,
              onRefresh: () => unawaited(_loadAssignments(force: true)),
            ),
          ),

          if (_loading)
            Positioned(
              top: MediaQuery.of(context).padding.top,
              left: 0,
              right: 0,
              child: const LinearProgressIndicator(minHeight: 2),
            ),

          if (_error != null)
            Positioned(
              left: 12,
              right: 12,
              top: MediaQuery.of(context).padding.top + 56,
              child: Material(
                elevation: 2,
                borderRadius: BorderRadius.circular(8),
                color: Theme.of(context).colorScheme.errorContainer,
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Text(
                    _error!,
                    style: TextStyle(color: Theme.of(context).colorScheme.onErrorContainer),
                  ),
                ),
              ),
            ),

          if (_loadIssue != null && _error == null)
            Positioned(
              left: 12,
              right: 12,
              top: MediaQuery.of(context).padding.top + 56,
              child: Material(
                elevation: 2,
                borderRadius: BorderRadius.circular(8),
                color: Colors.orange.shade100,
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Text(
                    _loadIssue!,
                    style: TextStyle(color: Colors.orange.shade900),
                  ),
                ),
              ),
            ),

          // Add-mode action bar
          if (_tool == MapTool.addPoint)
            Positioned(
              left: 12,
              right: 12,
              bottom: 88,
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Pan map or tap to place. Snap ≤${_snapMeters.toInt()}m.',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                      TextButton.icon(
                        onPressed: _placeAtGps,
                        icon: const Icon(Icons.gps_fixed, size: 18),
                        label: const Text('GPS'),
                      ),
                      FilledButton(
                        onPressed: _confirmCenterPlacement,
                        child: const Text('Here'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          if (_tool == MapTool.drawSpan)
            Positioned(
              left: 12,
              right: 12,
              bottom: 88,
              child: Card(
                color: Colors.orange.shade50,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(
                    _spanSourceMrid == null
                        ? 'Span mode: tap the first pole or node'
                        : 'Tap the second node to save the span',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ),
            ),

          // Bottom toolbar (QField-style)
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: _MapToolbar(
              tool: _tool,
              followMe: _followMe,
              headingUp: _headingUp,
              loading: _loading,
              onPan: () => _setTool(MapTool.pan),
              onAdd: () => _setTool(MapTool.addPoint),
              onDrawSpan: () => _setTool(MapTool.drawSpan),
              onMeasure: () => _setTool(MapTool.measure),
              onLayers: _showLayers,
              onLocate: _centerOnMe,
              onRefresh: () {
                if (!_martinGridLatched) _probeMartinGrid();
                _loadNodes(anchor: _mapController.camera.center);
              },
            ),
          ),
          if (_tool == MapTool.measure)
            Positioned(
              left: 12,
              right: 12,
              bottom: 88,
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          _measurePoints.isEmpty
                              ? 'Measure: tap points on the map'
                              : 'Length: ${(_measureTotalMeters ?? 0).toStringAsFixed(1)} m (${_measurePoints.length} pts)',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                      TextButton(
                        onPressed: () => setState(() => _measurePoints = const []),
                        child: const Text('Clear'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          if (_stakeoutTarget != null && _stakeoutDistanceM != null)
            Positioned(
              left: 12,
              right: 12,
              bottom: _tool == MapTool.measure ? 148 : 88,
              child: Card(
                color: Colors.teal.shade50,
                child: ListTile(
                  dense: true,
                  title: Text(_stakeoutLabel ?? 'Navigate'),
                  subtitle: Text('${_stakeoutDistanceM!.toStringAsFixed(0)} m away'),
                  trailing: IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => setState(() {
                      _stakeoutTarget = null;
                      _stakeoutLabel = null;
                    }),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Compact chip showing assigned-territory scope with show/hide + fit actions.
class _AssignmentScopeChip extends StatelessWidget {
  const _AssignmentScopeChip({
    required this.hexCount,
    required this.visible,
    required this.loading,
    required this.technicianId,
    required this.onToggle,
    required this.onFit,
    required this.onRefresh,
  });

  final int hexCount;
  final bool visible;
  final bool loading;
  final String technicianId;
  final VoidCallback onToggle;
  final VoidCallback onFit;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final label = hexCount > 0 ? 'My area · $hexCount' : 'My area · none';
    return Material(
      elevation: 2,
      borderRadius: BorderRadius.circular(10),
      color: Colors.black.withValues(alpha: 0.72),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              visualDensity: VisualDensity.compact,
              tooltip: visible ? 'Hide my area' : 'Show my area',
              onPressed: onToggle,
              icon: Icon(
                visible ? Icons.layers : Icons.layers_clear,
                color: hexCount > 0
                    ? const Color(0xFFF59E0B)
                    : Colors.white54,
                size: 18,
              ),
            ),
            if (loading)
              const Padding(
                padding: EdgeInsets.only(right: 6),
                child: SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Color(0xFFF59E0B),
                  ),
                ),
              ),
            Text(
              label,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
            IconButton(
              visualDensity: VisualDensity.compact,
              tooltip: 'Refresh territory ($technicianId)',
              onPressed: loading ? null : onRefresh,
              icon: const Icon(
                Icons.refresh,
                color: Colors.white70,
                size: 18,
              ),
            ),
            if (hexCount > 0)
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: 'Zoom to my area',
                onPressed: onFit,
                icon: const Icon(
                  Icons.center_focus_strong,
                  color: Colors.white,
                  size: 18,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _StatusBar extends StatelessWidget {
  const _StatusBar({
    required this.position,
    required this.heading,
    required this.headingConfidence,
    required this.headingUp,
    required this.mapRotationDeg,
    required this.nodeCount,
    required this.vectorGrid,
    required this.usingCache,
    required this.isOnline,
    required this.linkUp,
    required this.serverReachable,
    required this.tool,
    required this.pendingCount,
    required this.onResetNorth,
    this.onPendingTap,
  });

  final Position? position;
  final double? heading;
  final double headingConfidence;
  final bool headingUp;
  final double mapRotationDeg;
  final int nodeCount;
  final bool vectorGrid;
  final bool usingCache;
  final bool isOnline;
  final bool linkUp;
  final bool serverReachable;
  final MapTool tool;
  final int pendingCount;
  final VoidCallback onResetNorth;
  final VoidCallback? onPendingTap;

  @override
  Widget build(BuildContext context) {
    final coords = position != null
        ? '${position!.latitude.toStringAsFixed(5)}, ${position!.longitude.toStringAsFixed(5)}'
        : 'No GPS';
    final accuracy = position != null
        ? '±${position!.accuracy.toStringAsFixed(0)}m'
        : '';
    final bearing = heading != null
        ? '${heading!.round()}° ${headingToCardinal(heading)}'
        : '—°';
    final headingQuality = headingConfidence < 0.45 ? ' · low heading' : '';

    return Material(
      elevation: 2,
      borderRadius: BorderRadius.circular(10),
      color: Colors.black.withValues(alpha: 0.72),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            if (heading != null)
              Transform.rotate(
                angle: headingUp
                    ? 0
                    : (heading! - mapRotationDeg) * math.pi / 180,
                child: const Icon(Icons.navigation, color: Color(0xFF64B5F6), size: 18),
              )
            else
              Icon(
                tool == MapTool.addPoint ? Icons.add_location : Icons.explore,
                color: Colors.white70,
                size: 18,
              ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                '$coords  $accuracy  ·  $bearing$headingQuality',
                style: const TextStyle(color: Colors.white, fontSize: 12),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (headingUp)
              GestureDetector(
                onTap: onResetNorth,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: const Text('N', style: TextStyle(color: Colors.white, fontSize: 11)),
                ),
              ),
            GestureDetector(
              onTap: onPendingTap,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    !linkUp
                        ? Icons.wifi_off
                        : (serverReachable ? Icons.wifi : Icons.cloud_off),
                    color: isOnline
                        ? Colors.lightGreenAccent
                        : Colors.orange.shade300,
                    size: 14,
                  ),
                  if (pendingCount > 0) ...[
                    const SizedBox(width: 4),
                    Icon(Icons.cloud_upload, color: Colors.orange.shade300, size: 16),
                    Text(
                      '$pendingCount',
                      style: TextStyle(color: Colors.orange.shade200, fontSize: 11),
                    ),
                  ],
                ],
              ),
            ),
            if (usingCache)
              const Padding(
                padding: EdgeInsets.only(left: 6),
                child: Icon(Icons.cloud_off, color: Colors.white54, size: 16),
              ),
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Text(
                vectorGrid ? 'SLD · $nodeCount' : '$nodeCount',
                style: TextStyle(
                  color: vectorGrid ? const Color(0xFF90CAF9) : Colors.white70,
                  fontSize: 12,
                  fontWeight: vectorGrid ? FontWeight.w600 : FontWeight.normal,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MapToolbar extends StatelessWidget {
  const _MapToolbar({
    required this.tool,
    required this.followMe,
    required this.headingUp,
    required this.loading,
    required this.onPan,
    required this.onAdd,
    required this.onDrawSpan,
    required this.onMeasure,
    required this.onLayers,
    required this.onLocate,
    required this.onRefresh,
  });

  final MapTool tool;
  final bool followMe;
  final bool headingUp;
  final bool loading;
  final VoidCallback onPan;
  final VoidCallback onAdd;
  final VoidCallback onDrawSpan;
  final VoidCallback onMeasure;
  final VoidCallback onLayers;
  final VoidCallback onLocate;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    return Material(
      elevation: 8,
      color: Theme.of(context).colorScheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _ToolButton(
                icon: Icons.pan_tool_alt,
                label: 'Pan',
                selected: tool == MapTool.pan,
                onTap: onPan,
              ),
              _ToolButton(
                icon: Icons.add_location_alt,
                label: 'Add',
                selected: tool == MapTool.addPoint,
                onTap: onAdd,
              ),
              _ToolButton(
                icon: Icons.timeline,
                label: 'Span',
                selected: tool == MapTool.drawSpan,
                onTap: onDrawSpan,
              ),
              _ToolButton(
                icon: Icons.straighten,
                label: 'Measure',
                selected: tool == MapTool.measure,
                onTap: onMeasure,
              ),
              _ToolButton(
                icon: Icons.layers,
                label: 'Layers',
                onTap: onLayers,
              ),
              _ToolButton(
                icon: Icons.navigation,
                label: headingUp ? 'Heading' : 'Locate',
                selected: followMe,
                onTap: onLocate,
              ),
              _ToolButton(
                icon: Icons.refresh,
                label: 'Reload',
                onTap: loading ? null : onRefresh,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ToolButton extends StatelessWidget {
  const _ToolButton({
    required this.icon,
    required this.label,
    this.selected = false,
    this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final color = selected
        ? Theme.of(context).colorScheme.primary
        : Theme.of(context).colorScheme.onSurface;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: color, size: 22),
            const SizedBox(height: 2),
            Text(
              label,
              style: TextStyle(fontSize: 11, color: color),
            ),
          ],
        ),
      ),
    );
  }
}

class _NodeDetailSheet extends StatelessWidget {
  const _NodeDetailSheet({
    required this.node,
    required this.topologyFuture,
    this.localCapture,
    this.onNavigate,
  });

  final AssetNode node;
  final Future<Map<String, dynamic>?> topologyFuture;
  final Map<String, dynamic>? localCapture;
  final VoidCallback? onNavigate;

  @override
  Widget build(BuildContext context) {
    final kind = node.displayKind;

    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        0,
        20,
        24 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: FutureBuilder<Map<String, dynamic>?>(
        future: topologyFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(assetKindIcon(kind), color: assetKindColor(kind)),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(node.name, style: Theme.of(context).textTheme.titleLarge),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                const LinearProgressIndicator(),
                const SizedBox(height: 12),
                Text(
                  'Loading connected lines…',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 8),
                _detailRow(context, 'MRID', node.mrid),
              ],
            );
          }

          if (snapshot.hasError && !node.isLocalQueued) {
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(node.name, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 12),
                Text(
                  'Could not load connections. Showing saved details.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 12),
                _NodeDetailBody(
                  node: node,
                  topology: null,
                  localCapture: localCapture,
                  onNavigate: onNavigate,
                ),
              ],
            );
          }

          return _NodeDetailBody(
            node: node,
            topology: snapshot.data,
            localCapture: localCapture,
            onNavigate: onNavigate,
          );
        },
      ),
    );
  }

  static Widget _detailRow(BuildContext context, String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 100,
            child: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

class _NodeDetailBody extends StatelessWidget {
  const _NodeDetailBody({
    required this.node,
    required this.topology,
    this.localCapture,
    this.onNavigate,
  });

  final AssetNode node;
  final Map<String, dynamic>? topology;
  final Map<String, dynamic>? localCapture;
  final VoidCallback? onNavigate;

  @override
  Widget build(BuildContext context) {
    final downstream = topology?['downstream'] as List<dynamic>? ?? [];
    final upstream = topology?['upstream'] as List<dynamic>? ?? [];
    final degree = (topology?['degree'] as num?)?.toInt();
    final kind = node.displayKind;
    final syncStatus =
        localCapture?['sync_status'] as String? ?? 'PENDING';
    final feeder = node.boundaryFeederId ??
        localCapture?['boundary_feeder_id'] as String?;
    final utility = node.operatingUtility ??
        localCapture?['operating_utility'] as String?;
    final substation = node.substationName ??
        localCapture?['substation_name'] as String?;

    return SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(assetKindIcon(kind), color: assetKindColor(kind)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(node.name, style: Theme.of(context).textTheme.titleLarge),
              ),
            ],
          ),
          if (node.isLocalQueued) ...[
            const SizedBox(height: 10),
            Chip(
              avatar: const Icon(Icons.phone_android, size: 18),
              label: Text(
                syncStatus == 'CONFLICTED'
                    ? 'Saved on device — needs review'
                    : 'Saved on device — uploads when online',
              ),
            ),
          ],
          const SizedBox(height: 12),
          _NodeDetailSheet._detailRow(context, 'Type', assetKindLabel(kind)),
          if (!node.isLocalQueued)
            _NodeDetailSheet._detailRow(context, 'MRID', node.mrid),
          _NodeDetailSheet._detailRow(
            context,
            'Status',
            node.isLocalQueued ? 'Pending upload' : node.validation,
          ),
          if (!node.isLocalQueued)
            _NodeDetailSheet._detailRow(context, 'Tier', layerLabel(node.layer)),
          if (feeder != null && feeder.isNotEmpty)
            _NodeDetailSheet._detailRow(context, 'Feeder', feeder),
          if (utility != null && utility.isNotEmpty)
            _NodeDetailSheet._detailRow(context, 'Utility', utility),
          if (substation != null && substation.isNotEmpty)
            _NodeDetailSheet._detailRow(context, 'District', substation),
          if (node.hasCoordinates)
            _NodeDetailSheet._detailRow(
              context,
              'Coordinates',
              '${node.latitude!.toStringAsFixed(6)}, ${node.longitude!.toStringAsFixed(6)}',
            ),
          if (node.hasCoordinates && onNavigate != null) ...[
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: onNavigate,
              icon: const Icon(Icons.navigation_outlined),
              label: const Text('Navigate here'),
            ),
          ],
          if (degree != null && !node.isLocalQueued) ...[
            const SizedBox(height: 12),
            Text(
              'Connections ($degree)',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            if (downstream.isNotEmpty || upstream.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  'Connected lines shown on map',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
          ],
          if (downstream.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('Downstream', style: Theme.of(context).textTheme.labelLarge),
            ...downstream.map((row) {
              final map = row as Map<String, dynamic>;
              return _connectionTile(
                map['neighbor_name'] as String? ?? '—',
                map['voltage'] as String? ?? '',
                true,
              );
            }),
          ],
          if (upstream.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('Upstream', style: Theme.of(context).textTheme.labelLarge),
            ...upstream.map((row) {
              final map = row as Map<String, dynamic>;
              return _connectionTile(
                map['neighbor_name'] as String? ?? '—',
                map['voltage'] as String? ?? '',
                false,
              );
            }),
          ],
          if (downstream.isEmpty && upstream.isEmpty) ...[
            const SizedBox(height: 12),
            Text(
              degree != null && degree > 0
                  ? 'Lines exist in the database but could not be drawn on the map.'
                  : node.hasWireConnections
                      ? 'Could not load connection details. Pull to refresh the map.'
                      : 'This asset has no line segments in the master grid yet (orphan pole/DT). '
                          'Tap a node with the blue link badge to see connected lines.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ],
      ),
    );
  }

  static Widget _connectionTile(String name, String voltage, bool downstream) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      dense: true,
      leading: Icon(
        downstream ? Icons.arrow_downward : Icons.arrow_upward,
        size: 18,
        color: voltageLineColor(voltage),
      ),
      title: Text(name, maxLines: 2, overflow: TextOverflow.ellipsis),
      subtitle: voltage.isNotEmpty ? Text(voltage) : null,
    );
  }
}
