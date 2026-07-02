import 'package:shared_preferences/shared_preferences.dart';

/// Field-operator UI preferences (local; no server profile yet).
class FieldUserPreferences {
  FieldUserPreferences._();

  static const _headingUpKey = 'field.pref.heading_up_default';
  static const _showWorkOrdersKey = 'field.pref.show_work_orders_map';
  static const _autoSyncKey = 'field.pref.auto_sync_on_connect';
  static const _showAssignmentsKey = 'field.pref.show_assignments';

  static Future<bool> headingUpDefault() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_headingUpKey) ?? false;
  }

  static Future<void> setHeadingUpDefault(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_headingUpKey, value);
  }

  static Future<bool> showWorkOrdersOnMap() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_showWorkOrdersKey) ?? true;
  }

  static Future<void> setShowWorkOrdersOnMap(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_showWorkOrdersKey, value);
  }

  static Future<bool> autoSyncOnConnect() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_autoSyncKey) ?? true;
  }

  static Future<void> setAutoSyncOnConnect(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_autoSyncKey, value);
  }

  static Future<bool> showAssignmentsDefault() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_showAssignmentsKey) ?? true;
  }

  static Future<void> setShowAssignmentsDefault(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_showAssignmentsKey, value);
  }
}
