import 'package:flutter/material.dart';

/// SLD palette aligned with portal `giopMapLayers.ts` / `giopSldTheme.ts`.
/// LV uses rich slate (not pure black) so network lines read clearly on light basemaps.
abstract final class GiopSldColors {
  static const mv33kv = Color(0xFF1D4ED8);
  static const mv11kv = Color(0xFFB91C1C);
  static const hv = Color(0xFF78350F);
  /// Overhead LV — slate-700 (FR SLD: softened from #0F172A).
  static const lv = Color(0xFF334155);
  /// Underground / dashed LV — slate-500.
  static const lvDash = Color(0xFF64748B);
  static const unknownLine = Color(0xFF475569);
  static const nodeFill = Color(0xFF334155);
  static const nodeStroke = Color(0xFFFFFFFF);
  static const distributionTransformer = Color(0xFFE65100);
  static const powerTransformer = Color(0xFF7C3AED);
  /// Soft map canvas behind semi-transparent basemap tiles.
  static const mapBackground = Color(0xFFE8EDF3);
  static const basemapTileOpacity = 0.58;
}

Color giopVoltageColor(String? voltage, {bool light = true}) {
  switch (voltage) {
    case 'HV_161KV':
    case 'HV_330KV':
      return GiopSldColors.hv;
    case 'MV_33KV':
      return GiopSldColors.mv33kv;
    case 'MV_11KV':
      return GiopSldColors.mv11kv;
    case 'LV_230V':
    case 'LV_400V':
    case 'LV':
      return light ? GiopSldColors.lv : GiopSldColors.lvDash;
    default:
      return light ? GiopSldColors.unknownLine : const Color(0xFF94A3B8);
  }
}
