import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

/// Debug-mode NDJSON logger → Cursor ingest (dev machine :7771).
void agentLog({
  required String location,
  required String message,
  required String hypothesisId,
  Map<String, dynamic>? data,
  String runId = 'pre-fix',
  String? ingestHost,
}) {
  final payload = <String, dynamic>{
    'sessionId': '207c92',
    'timestamp': DateTime.now().millisecondsSinceEpoch,
    'location': location,
    'message': message,
    'hypothesisId': hypothesisId,
    'data': data ?? <String, dynamic>{},
    'runId': runId,
  };
  // Always emit to logcat so it is visible in the pasted device output.
  debugPrint('AGENTLOG ${jsonEncode(payload)}');
  unawaited(_agentLogAsync(
    location: location,
    message: message,
    hypothesisId: hypothesisId,
    data: data,
    runId: runId,
    ingestHost: ingestHost,
  ));
}

Future<void> _agentLogAsync({
  required String location,
  required String message,
  required String hypothesisId,
  Map<String, dynamic>? data,
  String runId = 'pre-fix',
  String? ingestHost,
}) async {
  final payload = <String, dynamic>{
    'sessionId': '207c92',
    'timestamp': DateTime.now().millisecondsSinceEpoch,
    'location': location,
    'message': message,
    'hypothesisId': hypothesisId,
    'data': data ?? <String, dynamic>{},
    'runId': runId,
  };
  final body = jsonEncode(payload);
  final hosts = <String>[
    if (ingestHost != null && ingestHost.isNotEmpty) ingestHost,
    '10.0.2.2',
    '127.0.0.1',
  ];
  for (final host in hosts) {
    final client = HttpClient();
    try {
      final req = await client.postUrl(
        Uri.parse(
          'http://$host:7771/ingest/c7d2ea3f-61be-4e5f-b77c-bfd46e6a1eff',
        ),
      );
      req.headers.set('Content-Type', 'application/json');
      req.headers.set('X-Debug-Session-Id', '207c92');
      req.write(body);
      unawaited(req.close());
      client.close();
      return;
    } catch (_) {
      client.close(force: true);
    }
  }
}

String? hostFromUrl(String url) {
  final host = Uri.tryParse(url)?.host;
  if (host == null || host.isEmpty) return null;
  return host;
}
