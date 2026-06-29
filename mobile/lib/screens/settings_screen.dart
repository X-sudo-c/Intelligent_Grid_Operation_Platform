import 'package:flutter/material.dart';

import '../config/api_config.dart';
import '../services/giop_api.dart';
import '../services/settings_service.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.config,
    required this.onSaved,
  });

  final ApiConfig config;
  final ValueChanged<ApiConfig> onSaved;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _syncController;
  late final TextEditingController _ocrController;
  late final TextEditingController _supabaseController;
  late final TextEditingController _anonController;
  late final TextEditingController _technicianIdController;
  late final TextEditingController _technicianNameController;
  final TextEditingController _lanHostController = TextEditingController();
  final _settings = SettingsService();
  String? _message;
  String? _testResult;
  bool _testing = false;

  @override
  void initState() {
    super.initState();
    _syncController = TextEditingController(text: widget.config.syncBaseUrl);
    _ocrController = TextEditingController(text: widget.config.ocrBaseUrl);
    _supabaseController = TextEditingController(text: widget.config.supabaseUrl);
    _anonController = TextEditingController(text: widget.config.supabaseAnonKey);
    _technicianIdController = TextEditingController(text: widget.config.technicianId);
    _technicianNameController = TextEditingController(
      text: widget.config.technicianDisplayName ?? '',
    );
    _lanHostController.text = _hostFromConfig(widget.config);
  }

  String _hostFromConfig(ApiConfig config) {
    final uri = Uri.tryParse(config.supabaseUrl);
    final host = uri?.host;
    if (host == null || host.isEmpty || host == '10.0.2.2' || host == '127.0.0.1') {
      return '192.168.100.6';
    }
    return host;
  }

  @override
  void dispose() {
    _syncController.dispose();
    _ocrController.dispose();
    _supabaseController.dispose();
    _anonController.dispose();
    _technicianIdController.dispose();
    _technicianNameController.dispose();
    _lanHostController.dispose();
    super.dispose();
  }

  void _applyPreset(ApiConfig preset) {
    setState(() {
      _syncController.text = preset.syncBaseUrl;
      _ocrController.text = preset.ocrBaseUrl;
      _supabaseController.text = preset.supabaseUrl;
      _anonController.text = preset.supabaseAnonKey;
    });
  }

  ApiConfig _configFromForm() {
    final sync = ApiConfig.normalizeBaseUrl(_syncController.text);
    final displayName = _technicianNameController.text.trim();
    return ApiConfig(
      syncBaseUrl: sync,
      ocrBaseUrl: ApiConfig.normalizeBaseUrl(_ocrController.text),
      supabaseUrl: ApiConfig.normalizeBaseUrl(_supabaseController.text),
      supabaseAnonKey: _anonController.text.trim(),
      martinBaseUrl: ApiConfig.martinUrlFromSync(sync),
      technicianId: _technicianIdController.text.trim().isEmpty
          ? 'tech.demo'
          : _technicianIdController.text.trim(),
      technicianDisplayName: displayName.isEmpty ? null : displayName,
    );
  }

  void _applyLanHost() {
    final host = _lanHostController.text.trim();
    if (host.isEmpty) return;
    _applyPreset(ApiConfig.lanHost(host));
    setState(() => _message = 'Applied LAN host $host — tap Save');
  }

  Future<void> _testConnections() async {
    setState(() {
      _testing = true;
      _testResult = null;
    });
    final config = _configFromForm();
    final result = await GiopApi(config).testConnections();
    if (!mounted) return;
    setState(() {
      _testing = false;
      _testResult = result;
    });
  }

  Future<void> _save() async {
    final config = _configFromForm();
    await _settings.save(config);
    widget.onSaved(config);
    setState(() => _message = 'Settings saved');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton(
                onPressed: () => _applyPreset(ApiConfig.androidEmulator()),
                child: const Text('Android emulator preset'),
              ),
              OutlinedButton(
                onPressed: () => _applyPreset(ApiConfig.localhost()),
                child: const Text('Localhost preset'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _lanHostController,
                  decoration: const InputDecoration(
                    labelText: 'PC LAN IP (physical phone)',
                    border: OutlineInputBorder(),
                  ),
                  keyboardType: TextInputType.number,
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: _applyLanHost,
                child: const Text('Apply'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _testing ? null : _testConnections,
            icon: _testing
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.network_check),
            label: Text(_testing ? 'Testing…' : 'Test connections'),
          ),
          if (_testResult != null) ...[
            const SizedBox(height: 8),
            SelectableText(
              _testResult!,
              style: const TextStyle(fontSize: 12),
            ),
          ],
          const SizedBox(height: 16),
          TextField(
            controller: _syncController,
            decoration: const InputDecoration(
              labelText: 'Sync service URL',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Martin tiles: ${ApiConfig.martinUrlFromSync(_syncController.text.isEmpty ? widget.config.syncBaseUrl : _syncController.text)}',
            style: const TextStyle(fontSize: 12, color: Colors.grey),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _ocrController,
            decoration: const InputDecoration(
              labelText: 'OCR service URL',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _supabaseController,
            decoration: const InputDecoration(
              labelText: 'Supabase URL',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _anonController,
            decoration: const InputDecoration(
              labelText: 'Supabase anon key',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _technicianIdController,
            decoration: const InputDecoration(
              labelText: 'Technician ID (until auth)',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _technicianNameController,
            decoration: const InputDecoration(
              labelText: 'Display name on map (optional)',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(onPressed: _save, child: const Text('Save')),
          if (_message != null) ...[
            const SizedBox(height: 12),
            Text(_message!),
          ],
          const SizedBox(height: 24),
          const Text(
            'Physical phone: only Sync URL :5000 must work. Supabase :54321 is optional '
            '(not used on phone when sync host is your LAN IP).',
            style: TextStyle(fontSize: 12, color: Colors.grey),
          ),
        ],
      ),
    );
  }
}
