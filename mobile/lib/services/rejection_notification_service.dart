import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'giop_api.dart';

/// Polls sync-service for reject alerts and shows device notifications.
class RejectionNotificationService {
  RejectionNotificationService(this.api);

  final GiopApi api;
  final FlutterLocalNotificationsPlugin _notifications =
      FlutterLocalNotificationsPlugin();

  Timer? _timer;
  bool _initialized = false;
  final Set<String> _seenIds = {};

  void Function(FieldNotification notification)? onRejection;

  static const _prefsKey = 'giop_delivered_notification_ids';
  static const _channelId = 'giop_asset_rejections';
  static const _channelName = 'Asset rejections';

  Future<void> start() async {
    await _initPlugin();
    await _loadSeen();
    await poll();
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 25), (_) => poll());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _initPlugin() async {
    if (_initialized) return;

    const android = AndroidInitializationSettings('@mipmap/ic_launcher');
    const ios = DarwinInitializationSettings();
    await _notifications.initialize(
      const InitializationSettings(android: android, iOS: ios),
      onDidReceiveNotificationResponse: _onNotificationTap,
    );

    final androidPlugin = _notifications
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>();
    await androidPlugin?.requestNotificationsPermission();

    await androidPlugin?.createNotificationChannel(
      const AndroidNotificationChannel(
        _channelId,
        _channelName,
        description: 'Alerts when backoffice rejects a captured asset',
        importance: Importance.high,
      ),
    );

    _initialized = true;
  }

  Future<void> _loadSeen() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_prefsKey) ?? const [];
    _seenIds
      ..clear()
      ..addAll(raw);
  }

  Future<void> _saveSeen() async {
    final prefs = await SharedPreferences.getInstance();
    final trimmed = _seenIds.toList();
    if (trimmed.length > 200) {
      trimmed.removeRange(0, trimmed.length - 200);
      _seenIds
        ..clear()
        ..addAll(trimmed);
    }
    await prefs.setStringList(_prefsKey, trimmed);
  }

  Future<void> poll() async {
    try {
      final pending = await api.fetchUndeliveredNotifications();
      for (final notification in pending) {
        if (_seenIds.contains(notification.id)) {
          await api.markNotificationDelivered(notification.id);
          continue;
        }
        await _showNotification(notification);
        await api.markNotificationDelivered(notification.id);
        _seenIds.add(notification.id);
        onRejection?.call(notification);
      }
      await _saveSeen();
    } catch (e, st) {
      debugPrint('RejectionNotificationService poll failed: $e\n$st');
    }
  }

  Future<void> _showNotification(FieldNotification notification) async {
    final title = notification.title ?? 'Asset rejected';
    final body = notification.body ??
        'A captured asset was rejected. Open the app to review.';

    await _notifications.show(
      notification.id.hashCode,
      title,
      body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          _channelName,
          channelDescription:
              'Alerts when backoffice rejects a captured asset',
          importance: Importance.high,
          priority: Priority.high,
          icon: '@mipmap/ic_launcher',
        ),
        iOS: const DarwinNotificationDetails(),
      ),
      payload: jsonEncode(notification.toPayload()),
    );
  }

  void _onNotificationTap(NotificationResponse response) {
    final payload = response.payload;
    if (payload == null || payload.isEmpty) return;
    try {
      final map = jsonDecode(payload) as Map<String, dynamic>;
      onRejection?.call(FieldNotification.fromJson(map));
    } catch (_) {}
  }
}
