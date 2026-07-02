import 'dart:async';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:latlong2/latlong.dart';

import '../models/asset_kind.dart';
import '../models/capture_prefill.dart';
import '../models/hex_assignment.dart';
import '../services/capture_preferences.dart';
import '../services/capture_service.dart';
import '../services/giop_api.dart';
import '../utils/polygon.dart';

class FieldCaptureSheet extends StatefulWidget {
  const FieldCaptureSheet({
    super.key,
    required this.api,
    required this.captureService,
    required this.latitude,
    required this.longitude,
    this.snappedToName,
    this.gpsAccuracyM,
    this.assignments = const [],
    this.prefill,
  });

  final GiopApi api;
  final CaptureService captureService;
  final double latitude;
  final double longitude;
  final String? snappedToName;
  final double? gpsAccuracyM;
  final List<HexAssignment> assignments;
  final CapturePrefill? prefill;

  @override
  State<FieldCaptureSheet> createState() => _FieldCaptureSheetState();
}

class _FieldCaptureSheetState extends State<FieldCaptureSheet> {
  final _nameController = TextEditingController();
  final _substationController = TextEditingController();
  final _feederController = TextEditingController();
  String _utility = 'ECG_SOUTHERN';
  AssetKind _assetKind = AssetKind.poleLv;
  bool _loading = false;
  String? _message;
  String? _duplicateWarning;
  String? _photoPath;
  List<String> _feeders = const [];
  List<String> _substations = const [];
  bool _lookupsLoaded = false;

  static const _utilities = [
    'ECG_SOUTHERN',
    'ECG_NORTHERN',
    'NEDCO',
  ];

  static const _selectableKinds = [
    AssetKind.poleLv,
    AssetKind.pole11kv,
    AssetKind.pole33kv,
    AssetKind.distributionTransformer,
    AssetKind.powerTransformer,
    AssetKind.connectivityNode,
  ];

  static const _maxGpsAccuracyM = 25.0;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    final pre = widget.prefill;
    if (pre?.name != null) _nameController.text = pre!.name!;
    if (pre?.substation != null) _substationController.text = pre!.substation!;
    if (pre?.feederId != null) _feederController.text = pre!.feederId!;
    if (pre?.assetKind != null) _assetKind = pre!.assetKind!;

    final lastKind = await CapturePreferences.lastAssetKind();
    final lastFeeder = await CapturePreferences.lastFeeder();
    final lastSub = await CapturePreferences.lastSubstation();
    final lastUtil = await CapturePreferences.lastUtility();

    if (!mounted) return;
    setState(() {
      if (pre?.assetKind == null) _assetKind = lastKind;
      if (pre?.feederId == null && lastFeeder != null) {
        _feederController.text = lastFeeder;
      }
      if (pre?.substation == null && lastSub != null) {
        _substationController.text = lastSub;
      }
      if (lastUtil != null) _utility = lastUtil;
    });

    if (_nameController.text.isEmpty && pre?.recaptureMrid == null) {
      final auto = await CapturePreferences.nextAutoName(_assetKind);
      if (mounted) _nameController.text = auto;
    }

    await _checkDuplicate();
    await _loadLookups();
  }

  Future<void> _loadLookups() async {
    try {
      final feeders = await widget.api.fetchFeederLookup();
      final substations = await widget.api.fetchSubstationLookup();
      if (!mounted) return;
      setState(() {
        _feeders = feeders;
        _substations = substations;
        _lookupsLoaded = true;
      });
    } catch (_) {
      if (mounted) setState(() => _lookupsLoaded = true);
    }
  }

  Future<void> _checkDuplicate() async {
    try {
      final hits = await widget.api.fetchNearbyCheck(
        latitude: widget.latitude,
        longitude: widget.longitude,
      );
      if (!mounted) return;
      if (hits.isEmpty) {
        setState(() => _duplicateWarning = null);
        return;
      }
      final first = hits.first;
      setState(() {
        _duplicateWarning =
            'Near ${first.name} (${first.tier}, ${first.distanceM.toStringAsFixed(1)} m)';
      });
    } catch (_) {
      // offline — skip
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    _substationController.dispose();
    _feederController.dispose();
    super.dispose();
  }

  bool _hexAllowed() {
    final active = widget.assignments
        .where((h) => !h.isDone && !h.isBlocked)
        .toList();
    if (active.isEmpty) return true;
    final point = LatLng(widget.latitude, widget.longitude);
    return pointInAnyAssignment(point, active.map((h) => h.ring));
  }

  Future<void> _pickPhoto() async {
    final picker = ImagePicker();
    final file = await picker.pickImage(
      source: ImageSource.camera,
      maxWidth: 1920,
      imageQuality: 85,
    );
    if (file == null || !mounted) return;
    setState(() => _photoPath = file.path);
  }

  Future<void> _submit() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      setState(() => _message = 'Enter a name');
      return;
    }

    final accuracy = widget.gpsAccuracyM;
    if (accuracy != null && accuracy > _maxGpsAccuracyM) {
      setState(() => _message =
          'GPS accuracy ${accuracy.toStringAsFixed(0)} m — wait for a better fix');
      return;
    }

    final enforceHex = await CapturePreferences.enforceHexAssignment();
    if (!mounted) return;
    if (enforceHex && !_hexAllowed()) {
      setState(() => _message = 'Location is outside your assigned work area');
      return;
    }

    setState(() {
      _loading = true;
      _message = null;
    });

    String? h3Index;
    try {
      h3Index = await widget.api
          .fetchH3CellAt(
            latitude: widget.latitude,
            longitude: widget.longitude,
          )
          .timeout(const Duration(seconds: 2));
    } catch (_) {}

    final workOrderId =
        widget.prefill?.workOrderId ?? await CapturePreferences.activeWorkOrderId();

    final result = await widget.captureService.submit(
      name: name,
      latitude: widget.latitude,
      longitude: widget.longitude,
      operatingUtility: _utility,
      assetKind: _assetKind,
      substationName: _substationController.text.trim().isEmpty
          ? null
          : _substationController.text.trim(),
      boundaryFeederId: _feederController.text.trim().isEmpty
          ? null
          : _feederController.text.trim(),
      workOrderId: workOrderId,
      photoUrl: _photoPath,
      h3Index: h3Index,
      enforceHexAssignment: enforceHex,
      recaptureMrid: widget.prefill?.recaptureMrid,
    );

    await CapturePreferences.saveLastCapture(
      assetKind: _assetKind,
      feederId: _feederController.text.trim(),
      substation: _substationController.text.trim(),
      utility: _utility,
    );

    if (!mounted) return;
    Navigator.pop(context, result);
  }

  @override
  Widget build(BuildContext context) {
    final isRecapture = widget.prefill?.recaptureMrid != null;
    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 8,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              isRecapture ? 'Fix rejected capture' : 'New field asset',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 4),
            Text(
              '${widget.latitude.toStringAsFixed(6)}, ${widget.longitude.toStringAsFixed(6)}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            if (widget.gpsAccuracyM != null) ...[
              const SizedBox(height: 4),
              Text(
                'GPS ±${widget.gpsAccuracyM!.toStringAsFixed(0)} m',
                style: TextStyle(
                  color: widget.gpsAccuracyM! > _maxGpsAccuracyM
                      ? Theme.of(context).colorScheme.error
                      : Theme.of(context).colorScheme.primary,
                  fontSize: 12,
                ),
              ),
            ],
            if (widget.snappedToName != null) ...[
              const SizedBox(height: 8),
              Chip(
                avatar: const Icon(Icons.link, size: 18),
                label: Text('Snapped near ${widget.snappedToName}'),
              ),
            ],
            if (_duplicateWarning != null) ...[
              const SizedBox(height: 8),
              Material(
                color: Theme.of(context).colorScheme.tertiaryContainer,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Row(
                    children: [
                      const Icon(Icons.warning_amber, size: 20),
                      const SizedBox(width: 8),
                      Expanded(child: Text(_duplicateWarning!, style: const TextStyle(fontSize: 13))),
                    ],
                  ),
                ),
              ),
            ],
            const SizedBox(height: 16),
            DropdownButtonFormField<AssetKind>(
              initialValue: _assetKind,
              decoration: const InputDecoration(
                labelText: 'Asset type *',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final kind in _selectableKinds)
                  DropdownMenuItem(
                    value: kind,
                    child: Row(
                      children: [
                        Icon(assetKindIcon(kind), color: assetKindColor(kind), size: 20),
                        const SizedBox(width: 10),
                        Text(assetKindLabel(kind)),
                      ],
                    ),
                  ),
              ],
              onChanged: _loading
                  ? null
                  : (v) async {
                      if (v == null) return;
                      setState(() => _assetKind = v);
                      if (_nameController.text.trim().isEmpty) {
                        _nameController.text =
                            await CapturePreferences.nextAutoName(v);
                      }
                    },
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _nameController,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                labelText: 'Name *',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _utility,
              decoration: const InputDecoration(
                labelText: 'Operating utility',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final u in _utilities)
                  DropdownMenuItem(value: u, child: Text(u)),
              ],
              onChanged: _loading ? null : (v) => setState(() => _utility = v!),
            ),
            const SizedBox(height: 12),
            Autocomplete<String>(
              optionsBuilder: (text) {
                final q = text.text.toLowerCase();
                return _substations.where((s) => s.toLowerCase().contains(q));
              },
              onSelected: (v) => _substationController.text = v,
              fieldViewBuilder: (context, controller, focusNode, onFieldSubmitted) {
                if (controller.text.isEmpty && _substationController.text.isNotEmpty) {
                  controller.text = _substationController.text;
                }
                controller.addListener(() {
                  _substationController.text = controller.text;
                });
                return TextField(
                  controller: controller,
                  focusNode: focusNode,
                  decoration: InputDecoration(
                    labelText: 'Substation (optional)',
                    border: const OutlineInputBorder(),
                    suffixIcon: _lookupsLoaded
                        ? null
                        : const SizedBox(
                            width: 18,
                            height: 18,
                            child: Padding(
                              padding: EdgeInsets.all(12),
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          ),
                  ),
                );
              },
            ),
            const SizedBox(height: 12),
            Autocomplete<String>(
              optionsBuilder: (text) {
                final q = text.text.toLowerCase();
                return _feeders.where((f) => f.toLowerCase().contains(q));
              },
              onSelected: (v) => _feederController.text = v,
              fieldViewBuilder: (context, controller, focusNode, onFieldSubmitted) {
                if (controller.text.isEmpty && _feederController.text.isNotEmpty) {
                  controller.text = _feederController.text;
                }
                controller.addListener(() {
                  _feederController.text = controller.text;
                });
                return TextField(
                  controller: controller,
                  focusNode: focusNode,
                  decoration: const InputDecoration(
                    labelText: 'Boundary feeder ID (optional)',
                    border: OutlineInputBorder(),
                  ),
                );
              },
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _loading ? null : _pickPhoto,
              icon: Icon(_photoPath != null ? Icons.check_circle : Icons.photo_camera),
              label: Text(_photoPath != null ? 'Photo attached' : 'Add photo (optional)'),
            ),
            if (_message != null) ...[
              const SizedBox(height: 12),
              Text(_message!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ],
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _loading ? null : _submit,
              icon: _loading
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save),
              label: Text(_loading ? 'Saving…' : 'Save'),
            ),
          ],
        ),
      ),
    );
  }
}
