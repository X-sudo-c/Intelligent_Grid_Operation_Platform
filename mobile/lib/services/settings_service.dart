import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import '../config/api_config.dart';

class SettingsService {
  static const _key = 'giop_api_config';

  Future<ApiConfig> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw != null) {
      final config = ApiConfig.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      return _repairMartinUrl(config);
    }
    return Platform.isAndroid ? ApiConfig.androidEmulator() : ApiConfig.localhost();
  }

  /// Older saves omitted martinBaseUrl or kept localhost while sync used 10.0.2.2.
  ApiConfig _repairMartinUrl(ApiConfig config) {
    final expected = ApiConfig.martinUrlFromSync(config.syncBaseUrl);
    final syncHost = Uri.tryParse(config.syncBaseUrl)?.host ?? '';
    final martinHost = Uri.tryParse(config.martinBaseUrl)?.host ?? '';
    if (martinHost != syncHost) {
      return config.copyWith(martinBaseUrl: expected);
    }
    return config;
  }

  Future<void> save(ApiConfig config) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode(config.toJson()));
  }
}
