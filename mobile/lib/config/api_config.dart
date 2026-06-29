/// Default local dev URLs (Android emulator uses 10.0.2.2 for host machine).
class ApiConfig {
  ApiConfig({
    required this.syncBaseUrl,
    required this.ocrBaseUrl,
    required this.supabaseUrl,
    required this.supabaseAnonKey,
    this.martinBaseUrl = 'http://127.0.0.1:3001',
    this.technicianId = 'tech.demo',
    this.technicianDisplayName,
  });

  final String syncBaseUrl;
  final String ocrBaseUrl;
  final String supabaseUrl;
  final String supabaseAnonKey;
  final String martinBaseUrl;
  /// Placeholder until auth — sent as operator_id on captures and location pings.
  final String technicianId;
  final String? technicianDisplayName;

  /// Strips trailing slashes so `${syncBaseUrl}/api/...` never becomes `//api/...`.
  static String normalizeBaseUrl(String url) =>
      url.trim().replaceAll(RegExp(r'/+$'), '');

  String get normalizedSyncBaseUrl => normalizeBaseUrl(syncBaseUrl);

  static const defaultAnonKey =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

  /// Defaults tuned for Android emulator → host services.
  factory ApiConfig.androidEmulator() => ApiConfig(
        syncBaseUrl: 'http://10.0.2.2:5000',
        ocrBaseUrl: 'http://10.0.2.2:5002',
        supabaseUrl: 'http://10.0.2.2:54321',
        supabaseAnonKey: defaultAnonKey,
        martinBaseUrl: 'http://10.0.2.2:3001',
      );

  /// Physical phone on same Wi‑Fi as the dev machine (`host` = LAN IP, no scheme).
  factory ApiConfig.lanHost(String host) {
    final h = host.replaceAll(RegExp(r'^https?://'), '').split(':').first;
    return ApiConfig(
      syncBaseUrl: 'http://$h:5000',
      ocrBaseUrl: 'http://$h:5002',
      supabaseUrl: 'http://$h:54321',
      supabaseAnonKey: defaultAnonKey,
      martinBaseUrl: 'http://$h:3001',
    );
  }

  bool get usesEmulatorLoopback =>
      supabaseUrl.contains('10.0.2.2') || syncBaseUrl.contains('10.0.2.2');

  /// Physical phone on LAN: map + topology go through sync :5000 only.
  bool get preferSyncOnly {
    final syncHost = Uri.tryParse(syncBaseUrl)?.host ?? '';
    return syncHost.isNotEmpty &&
        syncHost != '10.0.2.2' &&
        syncHost != '127.0.0.1' &&
        syncHost != 'localhost';
  }

  /// Martin tile server on the same host as sync (port 3001).
  static String martinUrlFromSync(String syncBaseUrl) {
    final uri = Uri.tryParse(normalizeBaseUrl(syncBaseUrl));
    if (uri == null || uri.host.isEmpty) return 'http://127.0.0.1:3001';
    return '${uri.scheme}://${uri.host}:3001';
  }

  factory ApiConfig.localhost() => ApiConfig(
        syncBaseUrl: 'http://127.0.0.1:5000',
        ocrBaseUrl: 'http://127.0.0.1:5002',
        supabaseUrl: 'http://127.0.0.1:54321',
        supabaseAnonKey: defaultAnonKey,
        martinBaseUrl: 'http://127.0.0.1:3001',
      );

  ApiConfig copyWith({
    String? syncBaseUrl,
    String? ocrBaseUrl,
    String? supabaseUrl,
    String? supabaseAnonKey,
    String? martinBaseUrl,
    String? technicianId,
    String? technicianDisplayName,
  }) {
    return ApiConfig(
      syncBaseUrl: syncBaseUrl ?? this.syncBaseUrl,
      ocrBaseUrl: ocrBaseUrl ?? this.ocrBaseUrl,
      supabaseUrl: supabaseUrl ?? this.supabaseUrl,
      supabaseAnonKey: supabaseAnonKey ?? this.supabaseAnonKey,
      martinBaseUrl: martinBaseUrl ?? this.martinBaseUrl,
      technicianId: technicianId ?? this.technicianId,
      technicianDisplayName: technicianDisplayName ?? this.technicianDisplayName,
    );
  }

  Map<String, String> toJson() => {
        'syncBaseUrl': syncBaseUrl,
        'ocrBaseUrl': ocrBaseUrl,
        'supabaseUrl': supabaseUrl,
        'supabaseAnonKey': supabaseAnonKey,
        'martinBaseUrl': martinBaseUrl,
        'technicianId': technicianId,
        if (technicianDisplayName != null)
          'technicianDisplayName': technicianDisplayName!,
      };

  factory ApiConfig.fromJson(Map<String, dynamic> json) => ApiConfig(
        syncBaseUrl: normalizeBaseUrl(json['syncBaseUrl'] as String),
        ocrBaseUrl: normalizeBaseUrl(json['ocrBaseUrl'] as String),
        supabaseUrl: normalizeBaseUrl(json['supabaseUrl'] as String),
        supabaseAnonKey: json['supabaseAnonKey'] as String,
        martinBaseUrl: json['martinBaseUrl'] as String? ?? 'http://127.0.0.1:3001',
        technicianId: json['technicianId'] as String? ?? 'tech.demo',
        technicianDisplayName: json['technicianDisplayName'] as String?,
      );
}
