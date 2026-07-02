import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../services/capture_service.dart';
import '../services/giop_api.dart';

class MeterScreen extends StatefulWidget {
  const MeterScreen({super.key, required this.api});

  final GiopApi api;

  @override
  State<MeterScreen> createState() => _MeterScreenState();
}

class _MeterScreenState extends State<MeterScreen> {
  final _serialController = TextEditingController();
  final _kwhController = TextEditingController();
  final _mridController = TextEditingController();
  final _picker = ImagePicker();
  late final CaptureService _captureService;

  File? _image;
  String? _status;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _captureService = CaptureService(widget.api);
  }

  @override
  void dispose() {
    _serialController.dispose();
    _kwhController.dispose();
    _mridController.dispose();
    super.dispose();
  }

  Future<void> _pickImage(ImageSource source) async {
    final picked = await _picker.pickImage(source: source, imageQuality: 85);
    if (picked == null || !mounted) return;
    setState(() {
      _image = File(picked.path);
      _status = null;
    });
  }

  Future<void> _runOcr() async {
    if (_image == null) {
      setState(() => _status = 'Select a photo first');
      return;
    }
    setState(() {
      _loading = true;
      _status = 'Running OCR…';
    });
    try {
      final data = await widget.api.runMeterOcr(_image!);
      if (!mounted) return;
      _serialController.text = data['extracted_serial']?.toString() ?? '';
      if (data['extracted_kwh'] != null) {
        _kwhController.text = data['extracted_kwh'].toString();
      }
      _mridController.text = data['meter_mrid']?.toString() ?? '';
      final match = data['registry_match'] == true;
      setState(() {
        _status = match
            ? 'Registry match found'
            : 'Serial not in registry — enter MRID manually';
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _status = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _submitTelemetry() async {
    final mrid = _mridController.text.trim();
    final kwh = double.tryParse(_kwhController.text.trim());
    if (mrid.isEmpty || kwh == null || kwh <= 0) {
      setState(() => _status = 'Enter valid MRID and kWh reading');
      return;
    }
    setState(() {
      _loading = true;
      _status = 'Saving…';
    });
    try {
      final queued = await _captureService.submitMeterReading(
        meterMrid: mrid,
        activeEnergyKwh: kwh,
        serialNumber: _serialController.text.trim().isEmpty
            ? null
            : _serialController.text.trim(),
        photoPath: _image?.path,
      );
      if (!mounted) return;
      setState(() {
        _status = queued ? 'Saved' : 'Could not save';
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _status = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Meter Reading')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _loading ? null : () => _pickImage(ImageSource.camera),
                  icon: const Icon(Icons.camera_alt),
                  label: const Text('Camera'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _loading ? null : () => _pickImage(ImageSource.gallery),
                  icon: const Icon(Icons.photo_library),
                  label: const Text('Gallery'),
                ),
              ),
            ],
          ),
          if (_image != null) ...[
            const SizedBox(height: 12),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: Image.file(_image!, height: 160, fit: BoxFit.cover),
            ),
          ],
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _loading ? null : _runOcr,
            icon: const Icon(Icons.document_scanner),
            label: const Text('Extract with OCR'),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _serialController,
            decoration: const InputDecoration(
              labelText: 'Serial number',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _kwhController,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: 'kWh reading',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _mridController,
            decoration: const InputDecoration(
              labelText: 'Meter MRID',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _loading ? null : _submitTelemetry,
            icon: const Icon(Icons.check),
            label: const Text('Confirm & submit telemetry'),
          ),
          if (_status != null) ...[
            const SizedBox(height: 16),
            Text(_status!),
          ],
        ],
      ),
    );
  }
}
