import 'dart:async';

import 'package:flutter/material.dart';

import 'config/api_config.dart';
import 'models/capture_prefill.dart';
import 'screens/map_screen.dart';
import 'screens/meter_screen.dart';
import 'screens/settings_screen.dart';
import 'screens/work_orders_screen.dart';
import 'services/field_map_refresh_bus.dart';
import 'services/giop_api.dart';
import 'services/rejection_notification_service.dart';
import 'services/settings_service.dart';

void main() {
  runZonedGuarded(
    () {
      WidgetsFlutterBinding.ensureInitialized();
      FlutterError.onError = (details) {
        FlutterError.presentError(details);
      };
      runApp(const GiopFieldApp());
    },
    (error, stack) {
      final label = error.toString();
      if (label == 'Cancelled' || label.contains('CancellationException')) {
        return;
      }
      debugPrint('Uncaught error: $error\n$stack');
    },
  );
}

class GiopFieldApp extends StatefulWidget {
  const GiopFieldApp({super.key});

  @override
  State<GiopFieldApp> createState() => _GiopFieldAppState();
}

class _GiopFieldAppState extends State<GiopFieldApp> {
  final _settings = SettingsService();
  ApiConfig? _config;
  GiopApi? _api;

  @override
  void initState() {
    super.initState();
    _loadConfig();
  }

  Future<void> _loadConfig() async {
    final config = await _settings.load();
    setState(() {
      _config = config;
      _api = GiopApi(config);
    });
  }

  void _updateConfig(ApiConfig config) {
    setState(() {
      _config = config;
      _api = GiopApi(config);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_config == null || _api == null) {
      return MaterialApp(
        home: Scaffold(
          body: Center(
            child: CircularProgressIndicator(
              color: Theme.of(context).colorScheme.primary,
            ),
          ),
        ),
      );
    }

    return MaterialApp(
      title: 'GIOP Field',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      home: HomeShell(
        api: _api!,
        config: _config!,
        onConfigSaved: _updateConfig,
      ),
    );
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.api,
    required this.config,
    required this.onConfigSaved,
  });

  final GiopApi api;
  final ApiConfig config;
  final ValueChanged<ApiConfig> onConfigSaved;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _index = 0;
  int _mapRefreshTrigger = 0;
  int _rejectionBadge = 0;
  CapturePrefill? _recapturePrefill;
  RejectionNotificationService? _rejectionNotifications;
  final _scaffoldKey = GlobalKey<ScaffoldMessengerState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _rejectionNotifications = RejectionNotificationService(widget.api)
      ..onRejection = _onAssetRejected
      ..start();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _rejectionNotifications?.stop();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _rejectionNotifications?.poll();
      if (_index == 0) {
        _mapRefreshTrigger++;
      }
    }
  }

  void _onAssetRejected(FieldNotification notification) {
    if (!mounted) return;
    setState(() => _rejectionBadge++);
    final label = notification.name ?? notification.mrid ?? 'Asset';
    if (notification.latitude != null && notification.longitude != null) {
      FieldMapRefreshBus.instance.requestAt(
        notification.latitude!,
        notification.longitude!,
        ringK: 1,
      );
    }
    _scaffoldKey.currentState?.showSnackBar(
      SnackBar(
        content: Text('Rejected: $label'),
        action: SnackBarAction(
          label: 'Fix',
          onPressed: () {
            if (notification.mrid != null) {
              _openRecapture(TechnicianSubmission(
                mrid: notification.mrid!,
                name: notification.name ?? '',
                validation: 'REJECTED',
                latitude: notification.latitude,
                longitude: notification.longitude,
              ));
            } else {
              setState(() => _index = 1);
            }
          },
        ),
      ),
    );
  }

  void _openRecapture(TechnicianSubmission item) {
    setState(() {
      _recapturePrefill = CapturePrefill(
        recaptureMrid: item.mrid,
        name: item.name,
        latitude: item.latitude,
        longitude: item.longitude,
      );
      _index = 0;
      _mapRefreshTrigger++;
    });
  }

  void _clearRejectionBadge() {
    if (_rejectionBadge > 0) {
      setState(() => _rejectionBadge = 0);
    }
  }

  void _onTabSelected(int i) {
    setState(() {
      _index = i;
      if (i == 0) {
        _mapRefreshTrigger++;
      }
      if (i == 1) {
        _clearRejectionBadge();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      MapScreen(
        api: widget.api,
        refreshTrigger: _mapRefreshTrigger,
        recapturePrefill: _recapturePrefill,
        onRecaptureConsumed: () => setState(() => _recapturePrefill = null),
      ),
      WorkOrdersScreen(
        api: widget.api,
        onFixRejected: _openRecapture,
        onSelectWorkOrder: (id, feederMrid) {
          setState(() {
            _index = 0;
            _mapRefreshTrigger++;
          });
        },
      ),
      MeterScreen(api: widget.api),
      SettingsScreen(
        config: widget.config,
        onSaved: widget.onConfigSaved,
      ),
    ];

    return ScaffoldMessenger(
      key: _scaffoldKey,
      child: Scaffold(
        body: IndexedStack(index: _index, children: pages),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: _onTabSelected,
          destinations: [
            const NavigationDestination(
              icon: Icon(Icons.map),
              label: 'Map',
            ),
            NavigationDestination(
              icon: Badge(
                isLabelVisible: _rejectionBadge > 0,
                label: Text('$_rejectionBadge'),
                child: const Icon(Icons.assignment),
              ),
              label: 'Work',
            ),
            const NavigationDestination(
              icon: Icon(Icons.speed),
              label: 'Meter',
            ),
            const NavigationDestination(
              icon: Icon(Icons.settings),
              label: 'Settings',
            ),
          ],
        ),
      ),
    );
  }
}
