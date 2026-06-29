import 'package:shared_preferences/shared_preferences.dart';

import '../models/asset_kind.dart';

/// Remembers last capture choices and auto-name sequence per asset kind.
class CapturePreferences {
  CapturePreferences._();

  static const _lastKindKey = 'capture_last_asset_kind';
  static const _lastFeederKey = 'capture_last_feeder';
  static const _lastSubstationKey = 'capture_last_substation';
  static const _lastUtilityKey = 'capture_last_utility';
  static const _activeWorkOrderKey = 'capture_active_work_order_id';
  static const _enforceHexKey = 'capture_enforce_hex';
  static const _seqPrefix = 'capture_seq_';

  static Future<AssetKind> lastAssetKind() async {
    final prefs = await SharedPreferences.getInstance();
    return assetKindFromString(prefs.getString(_lastKindKey));
  }

  static Future<void> saveLastCapture({
    required AssetKind assetKind,
    String? feederId,
    String? substation,
    String? utility,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_lastKindKey, assetKindToApiValue(assetKind));
    if (feederId != null && feederId.isNotEmpty) {
      await prefs.setString(_lastFeederKey, feederId);
    }
    if (substation != null && substation.isNotEmpty) {
      await prefs.setString(_lastSubstationKey, substation);
    }
    if (utility != null && utility.isNotEmpty) {
      await prefs.setString(_lastUtilityKey, utility);
    }
  }

  static Future<String?> lastFeeder() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_lastFeederKey);
  }

  static Future<String?> lastSubstation() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_lastSubstationKey);
  }

  static Future<String?> lastUtility() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_lastUtilityKey);
  }

  static Future<String> nextAutoName(AssetKind kind) async {
    final prefs = await SharedPreferences.getInstance();
    final key = '$_seqPrefix${assetKindToApiValue(kind)}';
    final seq = (prefs.getInt(key) ?? 0) + 1;
    await prefs.setInt(key, seq);
    final label = assetKindLabel(kind).split(' ').first;
    return '$label $seq';
  }

  static Future<String?> activeWorkOrderId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_activeWorkOrderKey);
  }

  static Future<void> setActiveWorkOrderId(String? id) async {
    final prefs = await SharedPreferences.getInstance();
    if (id == null || id.isEmpty) {
      await prefs.remove(_activeWorkOrderKey);
    } else {
      await prefs.setString(_activeWorkOrderKey, id);
    }
  }

  static Future<bool> enforceHexAssignment() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_enforceHexKey) ?? true;
  }

  static Future<void> setEnforceHexAssignment(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_enforceHexKey, value);
  }
}
